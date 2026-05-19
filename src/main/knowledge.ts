import { readFile } from 'fs/promises';
import { extname, basename } from 'path';
import { parse as parseHtml } from 'node-html-parser';

export async function extractFromFile(filePath: string): Promise<{ title: string; content: string }> {
  const ext = extname(filePath).toLowerCase();
  const title = basename(filePath);
  if (ext === '.pdf') {
    const { default: pdf } = await import('pdf-parse');
    const buf = await readFile(filePath);
    const data = await pdf(buf);
    return { title, content: data.text };
  }
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    return { title, content: (await readFile(filePath)).toString('utf8') };
  }
  if (ext === '.html' || ext === '.htm') {
    const html = (await readFile(filePath)).toString('utf8');
    return { title, content: parseHtml(html).text };
  }
  if (ext === '.pptx' || ext === '.docx') {
    const yauzl = await loadYauzl();
    if (!yauzl) {
      return { title, content: `[Binary file: ${title} — install office parser to extract.]` };
    }
    const text = await extractOfficeText(filePath, ext);
    return { title, content: text };
  }
  return { title, content: `[Unsupported file type: ${ext}. Saved reference only.]` };
}

async function loadYauzl(): Promise<any | null> {
  try {
    return await import('yauzl');
  } catch {
    return null;
  }
}

async function extractOfficeText(filePath: string, ext: string): Promise<string> {
  const yauzl = await loadYauzl();
  if (!yauzl) return '[office parser unavailable]';
  const filterRe = ext === '.pptx' ? /ppt\/slides\/slide\d+\.xml$/ : /word\/document\.xml$/;
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err: any, zip: any) => {
      if (err) return reject(err);
      let buf = '';
      zip.on('entry', (entry: any) => {
        if (filterRe.test(entry.fileName)) {
          zip.openReadStream(entry, (e: any, rs: any) => {
            if (e) return zip.readEntry();
            const chunks: Buffer[] = [];
            rs.on('data', (c: Buffer) => chunks.push(c));
            rs.on('end', () => {
              const xml = Buffer.concat(chunks).toString('utf8');
              const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              buf += text + '\n';
              zip.readEntry();
            });
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on('end', () => resolve(buf.trim()));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

export async function fetchUrl(url: string): Promise<{ title: string; content: string }> {
  const resp = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
    }
  });
  const html = await resp.text();
  const root = parseHtml(html);
  const title = root.querySelector('title')?.text?.trim() || url;
  root.querySelectorAll('script,style,nav,footer,header,svg,form').forEach((n) => n.remove());
  const body = (root.querySelector('main')?.text || root.querySelector('article')?.text || root.text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, content: body.slice(0, 50_000) };
}
