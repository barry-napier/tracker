import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import {
  DRIVER_LABELS,
  MODEL_CHOICES,
  PROVIDER_LOGOS,
  useProviderInstances,
} from "./providers.ts";

/**
 * The combined agent+model picker (the builder chat's composer chip): one
 * panel, a provider rail on the left and a searchable model list on the
 * right — the reference layout Codex/Lindy use. Picking a row commits both
 * the ProviderInstance and the model override in one gesture; "Default"
 * rides the instance's pinned model. Model values are versioned ids
 * (RunPhaseOpts.model), never bare aliases.
 */
export function ModelPicker({
  provider,
  model,
  onPick,
}: {
  /** Selected ProviderInstance id; null until the instance list arrives. */
  provider: string | null;
  /** Ad-hoc model override; null = the instance's pinned model. */
  model: string | null;
  onPick: (provider: string, model: string | null) => void;
}) {
  const instances = useProviderInstances();
  const [open, setOpen] = useState(false);
  // The rail highlights an instance to browse; only a row click commits.
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Light-dismiss, and the search field takes focus on open.
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const options = (instances ?? []).filter((i) => i.enabled || i.id === provider);
  const selected = options.find((i) => i.id === provider) ?? null;
  const shown = options.find((i) => i.id === (browsing ?? provider)) ?? selected;

  const rows = useMemo(() => {
    if (!shown) return [];
    const catalog = MODEL_CHOICES[shown.driver];
    const all = [
      {
        value: null as string | null,
        label: "Default",
        detail: shown.model ?? "instance setting",
      },
      ...catalog.map((c) => ({ value: c.value as string | null, label: c.label, detail: c.value ?? "" })),
    ];
    const needle = query.trim().toLowerCase();
    if (needle === "") return all;
    return all.filter(
      (row) =>
        row.label.toLowerCase().includes(needle) || (row.detail ?? "").toLowerCase().includes(needle),
    );
  }, [shown, query]);

  const chipLabel =
    selected === null
      ? "No providers"
      : MODEL_CHOICES[selected.driver].find((c) => c.value === model)?.label ?? "Default";

  return (
    <div className="mp" ref={rootRef}>
      <button
        type="button"
        className="mp-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? `${selected.displayName} — model for this chat` : undefined}
        onClick={() => {
          setBrowsing(null);
          setQuery("");
          setOpen((o) => !o);
        }}
      >
        {selected && <img src={PROVIDER_LOGOS[selected.driver]} alt="" width={14} height={14} />}
        <span>{chipLabel}</span>
        <Icon name="chevron-down" size={11} />
      </button>
      {open && (
        <div className="mp-panel">
          {/* Provider rail: one logo per instance; click to browse its models. */}
          <div className="mp-rail" role="tablist" aria-label="Provider">
            {options.map((instance) => (
              <button
                key={instance.id}
                type="button"
                role="tab"
                aria-selected={instance.id === shown?.id}
                className={`mp-rail-item${instance.id === shown?.id ? " active" : ""}`}
                disabled={!instance.available}
                title={instance.availabilityReason ?? instance.displayName}
                onClick={() => {
                  setBrowsing(instance.id);
                  setQuery("");
                  searchRef.current?.focus();
                }}
              >
                <img src={PROVIDER_LOGOS[instance.driver]} alt="" width={20} height={20} />
              </button>
            ))}
          </div>
          <div className="mp-main">
            <input
              ref={searchRef}
              className="mp-search"
              placeholder="Search models…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
              }}
            />
            <div className="mp-rows" role="listbox" aria-label="Model">
              {rows.length === 0 && <div className="mp-empty dim">No matching models.</div>}
              {rows.map((row) => {
                const active =
                  shown?.id === provider && (row.value === model || (row.value === null && model === null));
                return (
                  <button
                    key={row.value ?? "default"}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className="mp-row"
                    onClick={() => {
                      if (shown) onPick(shown.id, row.value);
                      setOpen(false);
                    }}
                  >
                    <span className="mp-row-titles">
                      <span className="mp-row-name">
                        {row.label}
                        {active && (
                          <span className="mp-check">
                            <Icon name="check" size={13} />
                          </span>
                        )}
                      </span>
                      <span className="mp-row-detail dim">
                        {shown && (
                          <img src={PROVIDER_LOGOS[shown.driver]} alt="" width={12} height={12} />
                        )}
                        {shown ? DRIVER_LABELS[shown.driver] : ""}
                        {row.detail ? ` · ${row.detail}` : ""}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
