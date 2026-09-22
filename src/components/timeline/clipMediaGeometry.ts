import { sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from '../../editor/sourceLimit';
import { intersectFrameRange, type TimelineFrameWindow } from './timelineUtil';

export interface ClipMediaGeometry {
  leftPx: number;
  widthPx: number;
  durationInFrames: number;
  srcInFrame: number;
}

/** Visible part of a legacy video clip that extends past the source file. */
export function clipMediaHoldGeometry(options: {
  clipStartFrame: number;
  durationInFrames: number;
  srcInFrame: number;
  playbackRate: number;
  sourceDurationFrames: number;
  px: number;
  visibleWindow: TimelineFrameWindow;
}): ClipMediaGeometry | null {
  const available = Math.max(0, sourceFramesToTimelineFrames(
    options,
    options.sourceDurationFrames - Math.max(0, options.srcInFrame),
  ));
  const holdOffset = Math.min(options.durationInFrames, available);
  const holdDuration = options.durationInFrames - holdOffset;
  if (!(holdDuration > 0)) return null;
  const intersection = intersectFrameRange(
    options.clipStartFrame + holdOffset,
    holdDuration,
    options.visibleWindow,
  );
  if (!intersection) return null;
  return {
    leftPx: (intersection.startFrame - options.clipStartFrame) * options.px,
    widthPx: Math.max(1, (intersection.endFrame - intersection.startFrame) * options.px),
    durationInFrames: intersection.endFrame - intersection.startFrame,
    srcInFrame: options.sourceDurationFrames,
  };
}

export function clipMediaGeometry(options: {
  clipStartFrame: number;
  durationInFrames: number;
  srcInFrame: number;
  playbackRate: number;
  px: number;
  visibleWindow: TimelineFrameWindow;
}): ClipMediaGeometry | null {
  const intersection = intersectFrameRange(
    options.clipStartFrame,
    options.durationInFrames,
    options.visibleWindow,
  );
  if (!intersection) return null;
  const offsetFrames = intersection.startFrame - options.clipStartFrame;
  return {
    leftPx: offsetFrames * options.px,
    widthPx: Math.max(1, (intersection.endFrame - intersection.startFrame) * options.px),
    durationInFrames: intersection.endFrame - intersection.startFrame,
    srcInFrame: sourceWindowForTimelineRange(
      options,
      offsetFrames,
      intersection.endFrame - intersection.startFrame,
    ).startFrame,
  };
}
