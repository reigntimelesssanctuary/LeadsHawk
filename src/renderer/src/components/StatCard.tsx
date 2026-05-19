type ChipKind = 'open' | 'qualified' | 'disqualified' | 'archived' | 'brand';

export function StatCard({
  label, value, chip, chipKind
}: { label: string; value: number | string; chip: string; chipKind: ChipKind }) {
  return (
    <div className="card" style={{ padding: 20, flex: 1, minWidth: 200 }}>
      <div className="label">{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, marginTop: 8, marginBottom: 12 }}>{value}</div>
      <span className={`chip chip-${chipKind}`}>{chip}</span>
    </div>
  );
}
