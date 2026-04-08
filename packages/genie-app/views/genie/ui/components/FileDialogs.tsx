import { useCallback, useEffect, useRef, useState } from 'react';
import { theme } from '../../../../lib/theme';

// ============================================================================
// Shared button style
// ============================================================================

export const toolbarBtn = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  padding: '4px 8px',
  fontSize: '12px',
  fontFamily: theme.fontFamily,
  backgroundColor: 'transparent',
  color: theme.textDim,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  cursor: 'pointer',
  transition: 'background-color 0.1s ease, color 0.1s ease, border-color 0.1s ease',
  whiteSpace: 'nowrap' as const,
} as const;

const dialogOverlay = {
  position: 'fixed' as const,
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
} as const;

const dialog = {
  backgroundColor: theme.bgCard,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusMd,
  padding: '24px',
  minWidth: '320px',
  maxWidth: '480px',
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '16px',
} as const;

const dialogInput = {
  padding: '6px 10px',
  fontSize: '12px',
  fontFamily: theme.fontFamily,
  backgroundColor: theme.bg,
  color: theme.text,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box' as const,
} as const;

// ============================================================================
// InlineInput — used for inline rename
// ============================================================================

interface InlineInputProps {
  initialValue?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function InlineInput({ initialValue = '', placeholder = 'Name', onSubmit, onCancel }: InlineInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') onSubmit(value);
      else if (e.key === 'Escape') onCancel();
    },
    [value, onSubmit, onCancel],
  );

  return (
    <input
      ref={inputRef}
      style={{
        ...dialogInput,
        fontSize: '12px',
        padding: '1px 6px',
        borderRadius: '3px',
        width: '140px',
      }}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={onCancel}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ============================================================================
// DeleteDialog
// ============================================================================

interface DeleteDialogProps {
  names: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteDialog({ names, onConfirm, onCancel }: DeleteDialogProps) {
  const label = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
  return (
    <div style={dialogOverlay} onClick={onCancel} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <p style={{ fontSize: '14px', fontWeight: 600, color: theme.text, margin: 0 }}>Delete {label}?</p>
        <p style={{ fontSize: '12px', color: theme.textDim, margin: 0, lineHeight: 1.5 }}>
          This action cannot be undone.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button type="button" style={toolbarBtn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={{ ...toolbarBtn, color: theme.error, borderColor: theme.error }}
            onClick={onConfirm}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// CreateFolderDialog
// ============================================================================

interface CreateFolderDialogProps {
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function CreateFolderDialog({ onConfirm, onCancel }: CreateFolderDialogProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
  }, [name, onConfirm]);

  return (
    <div style={dialogOverlay} onClick={onCancel} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <p style={{ fontSize: '14px', fontWeight: 600, color: theme.text, margin: 0 }}>New Folder</p>
        <input
          ref={inputRef}
          style={dialogInput}
          placeholder="Folder name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
            else if (e.key === 'Escape') onCancel();
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button type="button" style={toolbarBtn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={{
              ...toolbarBtn,
              backgroundColor: `${theme.violet}33`,
              color: theme.text,
              borderColor: theme.violet,
              opacity: name.trim() ? 1 : 0.5,
              cursor: name.trim() ? 'pointer' : 'not-allowed',
            }}
            onClick={handleSubmit}
            disabled={!name.trim()}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
