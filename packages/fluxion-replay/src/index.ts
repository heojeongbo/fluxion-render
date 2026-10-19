// Core types

export type { LogEntry } from "./entities/log-channel/log-channel";
// Channels
export { LogChannel } from "./entities/log-channel/log-channel";
export type { MetricSample } from "./entities/metric-channel/metric-channel";
export { MetricChannel } from "./entities/metric-channel/metric-channel";
export type { RosChannelOptions } from "./entities/ros-channel/ros-channel";
export { RosChannel } from "./entities/ros-channel/ros-channel";
export type { VideoFrameInfo } from "./entities/video-channel/video-channel";
export { VideoChannel } from "./entities/video-channel/video-channel";
export type {
  EndListener,
  FrameListener,
  ReplayPlayerFrame,
  ReplayPlayerOptions,
  ReplayPlayerState,
  SeekListener,
  StateListener,
  TickListener,
} from "./features/player/model/replay-player";
// Player
export { ReplayPlayer } from "./features/player/model/replay-player";
export type { ReplayRecorderOptions } from "./features/recorder/model/replay-recorder";
// Recorder
export {
  ReplayRecorder,
  UnknownChannelError,
} from "./features/recorder/model/replay-recorder";
export { createReplaySession } from "./features/session/lib/create-replay-session";
export type { GapInfo } from "./features/session/lib/detect-gaps";
export { detectGaps } from "./features/session/lib/detect-gaps";
export { snapTimeToSegment } from "./features/session/lib/snap-time-to-segment";
export type {
  ReplaySessionMode,
  ReplaySessionOptions,
} from "./features/session/model/replay-session";
// Session (main orchestrator)
export { ReplaySession } from "./features/session/model/replay-session";
export type {
  DecodedFrame,
  RecordingSegment,
  ReplayStoreOptions,
  StorageInfo,
} from "./features/store/model/replay-store";
// Storage
export { ReplayStore } from "./features/store/model/replay-store";
export type { Thumbnail } from "./features/timeline/model/thumbnail-store";
export { ThumbnailStore } from "./features/timeline/model/thumbnail-store";
// Timeline utilities
export { TimelineIndex } from "./features/timeline/model/timeline-index";
export type { VideoRecorderOptions } from "./features/video/model/video-recorder";
// Video subsystem
export { VideoRecorder } from "./features/video/model/video-recorder";
export type {
  VideoDecoderConfig,
  VideoReplayerOptions,
} from "./features/video/model/video-replayer";
export { VideoReplayer } from "./features/video/model/video-replayer";
// Format & producer utilities (pure, no React)
export { formatBytes, formatMs } from "./shared/lib/format";
export { isQuotaExceededError } from "./shared/lib/is-quota-exceeded-error";
export type {
  LogSample,
  MetricSampleShape,
  NoisyMetricProducerOptions,
  RandomLogProducerOptions,
  Rng,
} from "./shared/lib/producers";
export {
  createNoisyMetricProducer,
  createRandomLogProducer,
} from "./shared/lib/producers";
export type { VirtualClockListener } from "./shared/lib/virtual-clock";
export { VirtualClock } from "./shared/lib/virtual-clock";
export type { BaseChannel, ChannelSchema } from "./shared/model/base-channel";
export type { ChannelId } from "./shared/model/channel-types";
export type { ReplayFrame, SerializedFrame } from "./shared/model/frame";
export { GenericRingBuffer } from "./shared/model/generic-ring-buffer";
export type {
  FrameReader,
  FrameWriter,
  ReplayClock,
  ReplayStorage,
  VideoChunkReader,
  VideoChunkWriter,
} from "./shared/model/storage";
