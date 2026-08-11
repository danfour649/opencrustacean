import type { ReplyPayload } from "../reply-payload.js";

export function extendPreparedDispatchState<State extends object, Values extends object>(
  state: State,
  values: Values,
): State & Values {
  return Object.assign(state, values);
}

type BlockProgressState = {
  accumulatedBlockText: string;
  accumulatedBlockTtsText: string;
  accumulatedBlockTtsMetadataSource?: ReplyPayload;
  blockCount: number;
};

export function accumulateBlockProgress(
  state: BlockProgressState,
  payload: ReplyPayload,
  text: string,
  joinsBufferedTtsDirective: boolean,
): void {
  state.accumulatedBlockText += state.accumulatedBlockText ? `\n${text}` : text;
  if (state.accumulatedBlockTtsText && !joinsBufferedTtsDirective) {
    state.accumulatedBlockTtsText += "\n";
  }
  state.accumulatedBlockTtsText += text;
  state.accumulatedBlockTtsMetadataSource = payload;
  state.blockCount++;
}

export function resetBlockProgress(state: BlockProgressState): void {
  state.accumulatedBlockText = "";
  state.accumulatedBlockTtsText = "";
  state.accumulatedBlockTtsMetadataSource = undefined;
}
