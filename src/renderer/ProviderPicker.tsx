import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { PROVIDER_LOGOS, useProviderInstances } from "./providers.ts";

/**
 * The provider selection control (promote card, and any surface picking an
 * agent): a chip trigger opening a panel of instance rows — brand mark,
 * name, check on the selection. An unavailable instance (binary missing, per
 * availability.ts) stays listed but unpickable, wearing its reason — the
 * defect is the information, hiding the row would just move the confusion
 * to claim time. Disabled instances don't appear unless currently selected.
 */
export function ProviderPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const instances = useProviderInstances();
  const [open, setOpen] = useState(false);
  // Fixed-position panel: board columns are scroll containers and would
  // clip an absolutely-positioned popover at the column edge.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Light-dismiss: click anywhere outside closes the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const options = (instances ?? []).filter((i) => i.enabled || i.id === value);
  const selected = options.find((i) => i.id === value) ?? null;

  return (
    <div className="pp" ref={rootRef}>
      <button
        type="button"
        className="pp-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor({ top: rect.bottom + 4, left: rect.left });
          setOpen((o) => !o);
        }}
      >
        {selected ? (
          <>
            <img src={PROVIDER_LOGOS[selected.driver]} alt="" width={16} height={16} />
            <span>{selected.displayName}</span>
          </>
        ) : (
          <span className="dim">{options.length === 0 ? "No providers" : value}</span>
        )}
        <Icon name="chevron-down" size={12} />
      </button>
      {open && anchor && (
        <div
          className="pp-panel"
          role="listbox"
          aria-label="Provider"
          style={{
            top: anchor.top,
            // Keep the panel on-screen when the trigger sits near the right edge.
            left: Math.min(anchor.left, Math.max(8, window.innerWidth - 268)),
          }}
        >
          {options.length === 0 && (
            <div className="pp-empty dim">Add a provider in Settings first.</div>
          )}
          {options.map((instance) => (
            <button
              key={instance.id}
              type="button"
              role="option"
              aria-selected={instance.id === value}
              className="pp-option"
              disabled={!instance.available}
              title={instance.availabilityReason ?? undefined}
              onClick={() => {
                onChange(instance.id);
                setOpen(false);
              }}
            >
              <img
                className={instance.available ? undefined : "pp-logo-off"}
                src={PROVIDER_LOGOS[instance.driver]}
                alt=""
                width={18}
                height={18}
              />
              <span className="pp-option-titles">
                <span className="pp-option-name">{instance.displayName}</span>
                {instance.availabilityReason && (
                  <span className="pp-option-reason">{instance.availabilityReason}</span>
                )}
              </span>
              {instance.id === value && (
                <span className="pp-check">
                  <Icon name="check" size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
