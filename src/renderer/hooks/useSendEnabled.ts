import { useQuery } from "@tanstack/react-query";
import type { Config, IpcResponse } from "../../shared/types";

/**
 * Returns whether sending is enabled based on the gmailScopes config.
 * In "read-organize" mode, send/compose are disabled at the UI level.
 */
export function useSendEnabled(): boolean {
  const { data: config } = useQuery<Config>({
    queryKey: ["general-config"],
    queryFn: async () => {
      const resp = (await window.api.settings.getConfig()) as IpcResponse<Config>;
      return resp.success ? resp.data : ({} as Config);
    },
    staleTime: 30_000,
  });

  return (config?.gmailScopes ?? "full") !== "read-organize";
}
