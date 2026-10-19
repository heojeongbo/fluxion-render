import type { ReplayStorage } from "../../../shared/model/storage";
import type { ReplayStore } from "../../store/model/replay-store";
import { ReplaySession, type ReplaySessionOptions } from "../model/replay-session";

export function createReplaySession<S extends ReplayStorage = ReplayStore>(
  opts: ReplaySessionOptions<S>,
): ReplaySession<S> {
  return new ReplaySession(opts);
}
