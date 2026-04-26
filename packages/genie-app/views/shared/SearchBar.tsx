import { useNats } from '@khal-os/sdk/app';
import { useCallback, useRef, useState } from 'react';
import { GENIE_SUBJECTS } from '../../lib/subjects';
import { theme } from '../../lib/theme';

// ============================================================================
// Types
// ============================================================================

export interface SearchResult {
  sessionId: string;
  sessionName: string;
  turnIndex: number;
  snippet: string;
  role: string;
  timestamp: string;
}

export interface SearchBarProps {
  orgId: string;
  /** Called when user clicks a search result. */
  onNavigate: (sessionId: string, turnIndex: number) => void;
}

// ============================================================================
// SearchBar Component
// ============================================================================

export function SearchBar({ orgId, onNavigate }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nats = useNats();
  const containerRef = useRef<HTMLDivElement>(null);

  const doSearch = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setResults([]);
        setShowResults(false);
        return;
      }
      setSearching(true);
      try {
        const data = await nats.request<SearchResult[]>(GENIE_SUBJECTS.sessions.search(orgId), {
          query: q.trim(),
          limit: 20,
        });
        setResults(Array.isArray(data) ? data : []);
        setShowResults(true);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [nats, orgId],
  );

  const handleChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => doSearch(value), 300);
    },
    [doSearch],
  );

  const handleSelect = useCallback(
    (result: SearchResult) => {
      setShowResults(false);
      setQuery('');
      onNavigate(result.sessionId, result.turnIndex);
    },
    [onNavigate],
  );

  // Close results on outside click
  const handleBlur = useCallback(() => {
    // Delay to allow click on result
    setTimeout(() => setShowResults(false), 200);
  }, []);

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
      {/* Input */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ color: theme.textMuted, fontSize: '13px' }}>{'\u2315'}</span>
        <input
          type="text"
          placeholder="Search conversations..."
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setShowResults(true);
          }}
          onBlur={handleBlur}
          aria-label="Search sessions"
          style={{
            flex: 1,
            padding: '6px 10px',
            fontSize: '12px',
            fontFamily: theme.fontFamily,
            backgroundColor: theme.bgCard,
            color: theme.text,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            outline: 'none',
          }}
        />
        {searching && <span style={{ fontSize: '11px', color: theme.textMuted }}>...</span>}
      </div>

      {/* Results dropdown */}
      {showResults && results.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '4px',
            backgroundColor: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusMd,
            maxHeight: '320px',
            overflow: 'auto',
            zIndex: 100,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
          }}
        >
          {results.map((result, idx) => (
            <button
              key={`${result.sessionId}-${result.turnIndex}-${idx}`}
              type="button"
              onClick={() => handleSelect(result)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                width: '100%',
                padding: '8px 12px',
                background: 'none',
                border: 'none',
                borderBottom: idx < results.length - 1 ? `1px solid ${theme.border}` : 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: theme.fontFamily,
                color: theme.text,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = theme.bgCardHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              {/* Session name + turn index */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                <span style={{ fontWeight: 500, color: theme.text }}>{result.sessionName}</span>
                <span style={{ fontSize: '10px', color: theme.textMuted }}>turn #{result.turnIndex}</span>
                <span
                  style={{
                    fontSize: '10px',
                    padding: '1px 4px',
                    borderRadius: '3px',
                    backgroundColor: result.role === 'user' ? `${theme.info}33` : `${theme.emerald}33`,
                    color: result.role === 'user' ? theme.text : theme.emerald,
                  }}
                >
                  {result.role}
                </span>
              </div>
              {/* Snippet */}
              <span
                style={{
                  fontSize: '11px',
                  color: theme.textDim,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {result.snippet}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
