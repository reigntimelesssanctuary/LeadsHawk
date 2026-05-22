export function Switch({
  checked, onChange, label, disabled
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div
      onClick={() => { if (!disabled) onChange(!checked); }}
      title={disabled ? 'Disabled' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        userSelect: 'none'
      }}
    >
      <span
        style={{
          position: 'relative',
          width: 38,
          height: 22,
          borderRadius: 999,
          background: checked ? '#6c5cf2' : '#d1d5db',
          transition: 'background 0.15s',
          flexShrink: 0
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: 'white',
            transition: 'left 0.15s',
            boxShadow: '0 1px 2px rgba(0,0,0,0.25)'
          }}
        />
      </span>
      {label && <span style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>{label}</span>}
    </div>
  );
}
