import type { SendAsAlias } from "../../shared/types";

/** Format an alias as "Display Name <email>" or just "email" */
function formatAlias(alias: SendAsAlias): string {
  return alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email;
}

/** Extract bare email from a potentially formatted "Name <email>" address. */
function extractEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>$/);
  return match ? match[1] : addr;
}

interface FromSelectorProps {
  aliases: SendAsAlias[];
  selected: string | undefined;
  onChange: (formatted: string) => void;
}

/**
 * Compact dropdown for selecting which send-as address to use.
 * Only renders when the account has 2+ aliases.
 */
export function FromSelector({ aliases, selected, onChange }: FromSelectorProps) {
  if (aliases.length < 2) return null;

  // Determine what's shown — match by bare email since selected may be formatted
  const selectedBare = selected ? extractEmail(selected).toLowerCase() : "";
  const current = selectedBare || aliases.find((a) => a.isDefault)?.email || aliases[0].email;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-gray-500 dark:text-gray-400 shrink-0">From</span>
      <select
        value={current}
        onChange={(e) => {
          const alias = aliases.find((a) => a.email === e.target.value);
          onChange(alias ? formatAlias(alias) : e.target.value);
        }}
        className="flex-1 min-w-0 bg-transparent border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-gray-900 dark:text-gray-100 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none"
      >
        {aliases.map((alias) => (
          <option key={alias.email} value={alias.email}>
            {alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email}
          </option>
        ))}
      </select>
    </div>
  );
}
