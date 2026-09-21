export const COURSE_DURATION_PRESETS = [1, 3, 5, 10, 15, 30] as const;

export interface CourseGenerationOptions {
  targetMinutes: number;
}

const CHINESE_SPEECH_CHARACTERS_PER_SECOND = 4;

export function normalizeCourseDurationMinutes(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(120, Math.max(0.5, Math.round(value * 2) / 2));
}

export function targetCourseCharacters(minutes: number, speed = 1): number {
  return Math.round(normalizeCourseDurationMinutes(minutes) * 60 * CHINESE_SPEECH_CHARACTERS_PER_SECOND * Math.max(0.5, speed));
}

export function estimateCourseScriptSeconds(script: string, speed = 1): number {
  const characters = [...script.replace(/\s+/g, '')].length;
  if (characters === 0) return 0;
  return Math.max(1, Math.ceil(characters / CHINESE_SPEECH_CHARACTERS_PER_SECOND / Math.max(0.5, speed)));
}

export function distributeCourseSeconds(scripts: string[], totalSeconds: number): number[] {
  if (scripts.length === 0) return [];
  const target = Math.max(scripts.length, Math.round(totalSeconds));
  const weights = scripts.map((script) => Math.max(1, [...script.replace(/\s+/g, '')].length));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const result = weights.map((weight) => Math.max(1, Math.floor((target * weight) / weightTotal)));
  let remaining = target - result.reduce((sum, seconds) => sum + seconds, 0);
  let index = 0;
  while (remaining > 0) {
    result[index % result.length] += 1;
    remaining -= 1;
    index += 1;
  }
  return result;
}
