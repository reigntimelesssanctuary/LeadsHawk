/**
 * v1.19.0 — Opus draft generator (Stage of contact outreach).
 *
 * Claude Opus 4.7 with extended thinking enabled writes a personalised
 * cold first-touch email for a single contact, grounded in:
 *   - the qualifying event (opp.headline, background, signal_summary)
 *   - the contact's role + seniority
 *   - the brand dossier (positioning, target_icp, competitive_summary)
 *   - the product (description, use_cases, differentiators)
 *
 * Encodes cold-email marketing best practices in the system prompt so the
 * model doesn't have to be told the same dos/don'ts every call.
 *
 * Extended thinking is enabled because cold email is a one-shot
 * writing-and-judgment task — the reasoning trace becomes "Why this
 * angle" in the UI, giving the operator a visible quality check before
 * sending.
 *
 * Versioning: each call to draftEmailForContact persists a NEW
 * contact_drafts row with draft_version = max(existing) + 1. The
 * previous active draft has is_active flipped to 0; the new row gets
 * is_active = 1. Both happen in a single transaction (DB enforces only
 * one is_active=1 per contact via partial unique index).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getClient, modelSupportsTemperature } from './llm.js';
import { getDb } from './db.js';
import { recordApiCall } from './spend.js';
import type { Brand, Product, Opportunity, Contact, ContactDraft } from '@shared/types';

const DRAFT_MODEL = 'claude-opus-4-7';
const DRAFT_MAX_TOKENS = 6000;       // covers extended-thinking budget + body
const DRAFT_THINKING_BUDGET = 4000;  // tokens reserved for the thinking trace

const DRAFT_SYSTEM = `You are writing a cold first-touch email on behalf of a
B2B sales operator. The email's relevance comes entirely from grounding in a
SPECIFIC recent event at the recipient's company, framed against the
recipient's role.

Hard rules:
- Subject ≤ 60 characters. Specific. No clickbait. No emojis.
  No "RE:" or "FW:" tricks.
- Body ≤ 120 words total. 3 short paragraphs maximum.
- Open with the event (their context), NOT with yourself.
- Reference the recipient's role naturally — don't lecture them on
  what their job is.
- Show competence in 1-2 sentences (a sharp observation about the
  event's implications). Do NOT pitch the product by name in this
  first email. The goal is to earn a reply, not to sell.
- Single specific CTA: "Open to a brief call next week to compare
  notes?" — lower commitment than "demo" or "meeting".
- End with a single clear question.

Forbidden phrases (will get the email instantly discarded by
sophisticated recipients):
- "I hope this email finds you well"
- "I wanted to reach out"
- "Circling back"
- "Just following up"
- "Synergies", "alignment", "leverage" used loosely
- Mail-merge artefacts like "{First Name}" or "[Company]"

Tone: confident, specific, brief. Like one operator emailing
another — not like marketing.

Format: mobile-readable. Most B2B recipients open on phone first.
Short paragraphs. No HTML formatting. No attachments. No images.

DO NOT include a signature — the sender's email platform appends
one automatically. End the body at the question, nothing after.

Use extended thinking to:
1. Identify the SPECIFIC angle that ties this event to this product
   for this role.
2. Reject the most generic version of that angle.
3. Find one sharp observation worth saying.
4. Draft the email.

Return strictly valid JSON only, no prose, no code fences:
{
  "subject": "...",
  "body": "...",
  "one_line_why": "<short summary of the angle choice>"
}`;

function buildDraftPrompt(args: {
  brand: Brand;
  product: Product;
  opp: Opportunity;
  contact: Contact;
  feedback: string | null;
  rankPosition: number;
  totalRanked: number;
}): string {
  const { brand, product, opp, contact, feedback, rankPosition, totalRanked } = args;
  const feedbackBlock = feedback
    ? `\n# Operator feedback on previous draft\n${feedback}\n\nIncorporate this feedback into the new draft. Treat it as authoritative.\n`
    : '';
  return `# Brand
Name: ${brand.name}
Positioning: ${brand.positioning || '(none)'}
Target ICP: ${brand.target_icp || '(none)'}
Competitive summary: ${brand.competitive_summary || '(none)'}

# Product
Name: ${product.name}
Description: ${product.description || ''}
Use cases:
${product.use_cases || ''}
Differentiators:
${product.differentiators || ''}

# Opportunity
Target company: ${opp.company}
Industry: ${opp.industry || '(unspecified)'}
Headline: ${opp.headline}
Background:
${opp.background || ''}
Buying signal: ${opp.signal_summary || ''}

# Recipient
Name: ${contact.full_name}
Title: ${contact.title || '(unknown)'}
Seniority: ${contact.seniority || '(unknown)'}
${contact.department ? `Department: ${contact.department}\n` : ''}Hunt rank position: ${rankPosition} of ${totalRanked}
${feedbackBlock}
# Task
Write the subject + body for THIS recipient about THIS event, following all
rules in the system prompt. Return JSON only.`;
}

export type DraftOutput = {
  subject: string;
  body: string;
  one_line_why: string | null;
  reasoning_trace: string | null;
};

/**
 * Persist a new draft for a contact. Always inserts a new
 * contact_drafts row (no overwrite). The previous active draft has
 * is_active flipped to 0; the new row gets is_active = 1. Returns the
 * persisted ContactDraft row.
 *
 * Also flips contact.contact_status from 'pending' → 'drafted' on the
 * FIRST draft (subsequent regenerations leave status alone).
 */
export async function draftEmailForContact(
  contactId: number,
  opts: { feedback?: string | null } = {}
): Promise<{ draft: ContactDraft; output: DraftOutput }> {
  const db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as Contact | undefined;
  if (!contact) throw new Error(`Contact ${contactId} not found`);
  const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(contact.opportunity_id) as Opportunity | undefined;
  if (!opp) throw new Error('Parent opportunity not found');
  const brand = opp.brand_id
    ? (db.prepare('SELECT * FROM brands WHERE id = ?').get(opp.brand_id) as Brand | undefined)
    : undefined;
  const product = opp.product_id
    ? (db.prepare('SELECT * FROM products WHERE id = ?').get(opp.product_id) as Product | undefined)
    : undefined;
  if (!brand || !product) {
    throw new Error('Opportunity is missing brand/product attribution');
  }

  // Compute rank position for the prompt's "Hunt rank position N of M".
  const siblings = db.prepare(
    'SELECT id, hunt_rank FROM contacts WHERE opportunity_id = ? ORDER BY hunt_rank ASC'
  ).all(opp.id) as Array<{ id: number; hunt_rank: number }>;
  const rankPosition = contact.hunt_rank;
  const totalRanked = siblings.length;

  const prompt = buildDraftPrompt({
    brand, product, opp, contact,
    feedback: opts.feedback?.trim() || null,
    rankPosition, totalRanked
  });

  const output = await callOpusWithThinking(DRAFT_SYSTEM, prompt, contact.id);

  // Persist as a new version.
  const latest = db.prepare(
    'SELECT MAX(draft_version) AS v FROM contact_drafts WHERE contact_id = ?'
  ).get(contact.id) as { v: number | null };
  const nextVersion = (latest?.v ?? 0) + 1;

  const tx = db.transaction(() => {
    db.prepare('UPDATE contact_drafts SET is_active = 0 WHERE contact_id = ? AND is_active = 1').run(contact.id);
    const r = db.prepare(`
      INSERT INTO contact_drafts (
        contact_id, draft_version, subject, body, reasoning_trace,
        one_line_why, human_edited, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 1)
    `).run(
      contact.id,
      nextVersion,
      output.subject,
      output.body,
      output.reasoning_trace,
      output.one_line_why
    );
    // Flip contact status to 'drafted' on first draft. Don't touch other
    // non-pending states (sent, skipped, etc.) — those represent later
    // decisions and shouldn't be reverted by regeneration.
    if (contact.contact_status === 'pending') {
      db.prepare(
        "UPDATE contacts SET contact_status = 'drafted', updated_at = datetime('now') WHERE id = ?"
      ).run(contact.id);
    }
    return Number(r.lastInsertRowid);
  });
  const newDraftId = tx();
  const draft = db.prepare('SELECT * FROM contact_drafts WHERE id = ?').get(newDraftId) as ContactDraft;
  return { draft, output };
}

/**
 * Switch which draft version is currently active. Used by the "version
 * dropdown" in the UI. Returns the now-active draft row.
 */
export function setActiveDraftVersion(contactId: number, draftId: number): ContactDraft {
  const db = getDb();
  const draft = db.prepare(
    'SELECT * FROM contact_drafts WHERE id = ? AND contact_id = ?'
  ).get(draftId, contactId) as ContactDraft | undefined;
  if (!draft) throw new Error(`Draft ${draftId} not found for contact ${contactId}`);
  const tx = db.transaction(() => {
    db.prepare('UPDATE contact_drafts SET is_active = 0 WHERE contact_id = ? AND is_active = 1').run(contactId);
    db.prepare('UPDATE contact_drafts SET is_active = 1 WHERE id = ?').run(draftId);
  });
  tx();
  return db.prepare('SELECT * FROM contact_drafts WHERE id = ?').get(draftId) as ContactDraft;
}

// ─── Opus + extended thinking plumbing ────────────────────────────

async function callOpusWithThinking(
  system: string,
  prompt: string,
  relatedContactId: number
): Promise<DraftOutput> {
  const client = getClient();
  const req: Anthropic.MessageCreateParamsNonStreaming = {
    model: DRAFT_MODEL,
    max_tokens: DRAFT_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: prompt }],
    // Extended thinking. Returns blocks with type: 'thinking' alongside
    // the regular text blocks. Anthropic disallows temperature when
    // thinking is enabled (it must be 1.0, which is the default).
    thinking: { type: 'enabled', budget_tokens: DRAFT_THINKING_BUDGET } as any
  };
  // Extended thinking requires temperature stay default (1.0). We don't
  // set it here even though modelSupportsTemperature() would say yes —
  // setting it WITH thinking enabled returns 400.
  void modelSupportsTemperature; // silence unused-import warning if any
  let resp: any;
  try {
    resp = await client.messages.create(req);
  } catch (e: any) {
    throw new Error(`Opus draft error: ${String(e?.message || e).slice(0, 300)}`);
  }
  // Spend recording — mirror llm.ts's pattern.
  recordApiCall({
    provider: 'anthropic',
    model: DRAFT_MODEL,
    stage: 'contact_draft',
    inputTokens: Number(resp?.usage?.input_tokens ?? 0),
    outputTokens: Number(resp?.usage?.output_tokens ?? 0),
    relatedId: relatedContactId
  });

  // Extract thinking + text blocks separately.
  let thinkingTrace = '';
  let textPayload = '';
  for (const block of (resp.content as any[])) {
    if (block.type === 'thinking') {
      thinkingTrace += (block.thinking ?? '') + '\n';
    } else if (block.type === 'text') {
      textPayload += block.text;
    }
  }
  thinkingTrace = thinkingTrace.trim();
  textPayload = textPayload.trim();

  const parsed = extractJson(textPayload);
  if (!parsed || typeof parsed !== 'object') {
    const head = textPayload.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Unparseable Opus draft response. Head: ${head}`);
  }
  const subject = String(parsed.subject ?? '').trim();
  const body = String(parsed.body ?? '').trim();
  const one_line_why = parsed.one_line_why ? String(parsed.one_line_why).trim() : null;
  if (!subject || !body) {
    throw new Error('Opus draft response missing subject or body');
  }
  return {
    subject,
    body,
    one_line_why,
    reasoning_trace: thinkingTrace || null
  };
}

/** Strip code fences and parse JSON. Tolerant of prose around the object. */
function extractJson(text: string): any | null {
  if (!text) return null;
  let s = text.replace(/```(?:json)?\s*\n?/gi, '').replace(/```\s*$/g, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* ignore */ }
  }
  return null;
}
