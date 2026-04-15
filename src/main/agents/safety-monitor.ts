/**
 * Anomaly detection for agent tool call patterns.
 *
 * Monitors per-task tool usage and flags suspicious patterns that may
 * indicate prompt injection, misuse, or runaway behavior. When an anomaly
 * is detected, the monitor emits a warning event so the orchestrator can
 * pause the task and surface a confirmation to the user.
 */

export interface AnomalyFlag {
  type: string;
  toolName: string;
  count: number;
  threshold: number;
  message: string;
}

export interface SafetyMonitorConfig {
  /** Max label modifications before flagging. Default: 10. */
  maxLabelModifications?: number;
  /** Max TRASH/SPAM attempts (already blocked, but pattern is suspicious). Default: 3. */
  maxTrashSpamAttempts?: number;
  /** Max memory saves before flagging. Default: 3. */
  maxMemorySaves?: number;
}

const DEFAULT_CONFIG: Required<SafetyMonitorConfig> = {
  maxLabelModifications: 10,
  maxTrashSpamAttempts: 3,
  maxMemorySaves: 3,
};

/**
 * Per-task safety monitor. Create one per task in the orchestrator.
 * Call `recordToolCall()` before each tool execution. If it returns
 * an AnomalyFlag, pause the task and surface the warning to the user.
 */
export class SafetyMonitor {
  private config: Required<SafetyMonitorConfig>;
  private labelModCount = 0;
  private trashSpamAttempts = 0;
  private memorySaveCount = 0;

  constructor(config?: SafetyMonitorConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a tool call and check for anomalies.
   * Returns an AnomalyFlag if the pattern is suspicious, null otherwise.
   */
  recordToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): AnomalyFlag | null {
    if (toolName === "modify_labels") {
      this.labelModCount++;

      // Check for TRASH/SPAM attempts (these are blocked by the tool, but the
      // pattern of repeatedly attempting them is itself suspicious)
      const addLabelIds = args.addLabelIds;
      if (Array.isArray(addLabelIds)) {
        const hasTrashSpam = addLabelIds.some(
          (id) => id === "TRASH" || id === "SPAM",
        );
        if (hasTrashSpam) {
          this.trashSpamAttempts++;
          if (this.trashSpamAttempts >= this.config.maxTrashSpamAttempts) {
            return {
              type: "repeated_trash_spam",
              toolName,
              count: this.trashSpamAttempts,
              threshold: this.config.maxTrashSpamAttempts,
              message: `Agent has attempted to move emails to TRASH/SPAM ${this.trashSpamAttempts} times. This pattern may indicate prompt injection.`,
            };
          }
        }
      }

      if (this.labelModCount >= this.config.maxLabelModifications) {
        return {
          type: "bulk_label_modification",
          toolName,
          count: this.labelModCount,
          threshold: this.config.maxLabelModifications,
          message: `Agent has modified labels on ${this.labelModCount} emails in a single task. Please verify this is intended.`,
        };
      }
    }

    if (toolName === "save_memory") {
      this.memorySaveCount++;
      if (this.memorySaveCount >= this.config.maxMemorySaves) {
        return {
          type: "excessive_memory_saves",
          toolName,
          count: this.memorySaveCount,
          threshold: this.config.maxMemorySaves,
          message: `Agent has saved ${this.memorySaveCount} memories in a single task. This is unusual and may indicate an attempt to influence future behavior.`,
        };
      }
    }

    return null;
  }
}
