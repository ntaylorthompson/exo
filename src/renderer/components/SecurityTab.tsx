import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Config } from "../../shared/types";

interface SecurityTabProps {
  config: Config | undefined;
}

export function SecurityTab({ config }: SecurityTabProps) {
  const queryClient = useQueryClient();

  const mode = config?.trustedSendersMode;
  const [enabled, setEnabled] = useState(mode?.enabled ?? false);
  const [domainsAutoTrust, setDomainsAutoTrust] = useState(mode?.domainsAutoTrust ?? true);
  const [senders, setSenders] = useState<string[]>(mode?.senders ?? []);
  const [newSender, setNewSender] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [gmailScopes, setGmailScopes] = useState<"full" | "read-organize">(
    config?.gmailScopes ?? "full",
  );

  useEffect(() => {
    if (mode) {
      setEnabled(mode.enabled ?? false);
      setDomainsAutoTrust(mode.domainsAutoTrust ?? true);
      setSenders(mode.senders ?? []);
    }
    if (config?.gmailScopes) {
      setGmailScopes(config.gmailScopes);
    }
  }, [mode, config?.gmailScopes]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await window.api.settings.set({
        trustedSendersMode: {
          enabled,
          senders,
          domainsAutoTrust,
        },
        gmailScopes,
      });
      await queryClient.invalidateQueries({ queryKey: ["general-config"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const addSender = () => {
    const trimmed = newSender.trim().toLowerCase();
    if (!trimmed) return;
    if (senders.includes(trimmed)) return;
    setSenders([...senders, trimmed]);
    setNewSender("");
  };

  const removeSender = (pattern: string) => {
    setSenders(senders.filter((s) => s !== pattern));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addSender();
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          Trusted Senders
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          When enabled, only emails from trusted senders are analyzed by AI and eligible for
          auto-drafting. Untrusted email bodies are never sent to the LLM — the agent can see
          metadata (subject, sender, date) but not the content.
        </p>

        <div className="bg-amber-50 dark:bg-amber-900/30 p-4 rounded-lg mb-6">
          <h3 className="font-semibold text-amber-900 dark:text-amber-200 mb-2">
            How trust is determined:
          </h3>
          <ol className="text-sm text-amber-800 dark:text-amber-300 space-y-1 list-decimal list-inside">
            <li>Your own email addresses are always trusted</li>
            <li>Addresses and domains in your trusted list below</li>
            <li>
              {domainsAutoTrust
                ? "Domains you've previously sent email to (auto-trust enabled)"
                : "Auto-trust from sent history is disabled"}
            </li>
            <li>Everyone else is untrusted</li>
          </ol>
        </div>

        {/* Enable toggle */}
        <div className="flex items-center space-x-3 mb-6">
          <button
            onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              enabled ? "bg-blue-600 dark:bg-blue-500" : "bg-gray-200 dark:bg-gray-700"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Enable Trusted Senders mode
          </span>
        </div>

        {enabled && (
          <div className="space-y-6">
            {/* Auto-trust toggle */}
            <div className="flex items-center space-x-3">
              <button
                onClick={() => setDomainsAutoTrust(!domainsAutoTrust)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  domainsAutoTrust
                    ? "bg-blue-600 dark:bg-blue-500"
                    : "bg-gray-200 dark:bg-gray-700"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    domainsAutoTrust ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
              <div>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Auto-trust domains I've sent to
                </span>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Automatically trust senders from domains you've previously emailed
                </p>
              </div>
            </div>

            {/* Sender list */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Trusted senders and domains
              </label>
              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={newSender}
                  onChange={(e) => setNewSender(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="alice@example.com or *@company.com"
                  className="flex-1 p-2.5 border border-gray-300 dark:border-gray-500 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-gray-100"
                />
                <button
                  onClick={addSender}
                  disabled={!newSender.trim()}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 dark:bg-blue-500 rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 transition-colors"
                >
                  Add
                </button>
              </div>

              {senders.length > 0 ? (
                <div className="border border-gray-200 dark:border-gray-600 rounded-lg divide-y divide-gray-200 dark:divide-gray-600">
                  {senders.map((pattern) => (
                    <div
                      key={pattern}
                      className="flex items-center justify-between px-4 py-2.5"
                    >
                      <span className="text-sm text-gray-800 dark:text-gray-200 font-mono">
                        {pattern}
                      </span>
                      <button
                        onClick={() => removeSender(pattern)}
                        className="text-sm text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                  No trusted senders added yet. Add email addresses or use *@domain.com for entire
                  domains.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Save button */}
        <div className="flex justify-end mt-6">
          <button
            onClick={handleSave}
            disabled={saving || saved}
            className="px-6 py-2 bg-blue-600 dark:bg-blue-500 text-white text-sm font-medium rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors disabled:opacity-50"
          >
            {saving ? "Saving..." : saved ? "Saved!" : "Save Changes"}
          </button>
        </div>
      </div>

      {/* Gmail Permission Scope */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          Gmail Permissions
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          Control what permissions Exo requests from your Gmail account. In &quot;Read &amp;
          Organize&quot; mode, send and compose permissions are not requested — the Send button and
          outbox are disabled.
        </p>

        <div className="space-y-3">
          <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-600 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800">
            <input
              type="radio"
              name="gmailScopes"
              value="full"
              checked={gmailScopes === "full"}
              onChange={() => setGmailScopes("full")}
              className="mt-1"
            />
            <div>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Full access
              </span>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Read, compose, send, and organize emails. Required for sending replies and drafts.
              </p>
            </div>
          </label>
          <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-600 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800">
            <input
              type="radio"
              name="gmailScopes"
              value="read-organize"
              checked={gmailScopes === "read-organize"}
              onChange={() => setGmailScopes("read-organize")}
              className="mt-1"
            />
            <div>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Read &amp; Organize only
              </span>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Read and label emails only. No send or compose permissions. You will need to
                re-authorize after changing this setting.
              </p>
            </div>
          </label>
        </div>

        {gmailScopes !== (config?.gmailScopes ?? "full") && (
          <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">
            Changing scope mode requires re-authorization. Save and re-add your account to apply.
          </p>
        )}
      </div>
    </div>
  );
}
