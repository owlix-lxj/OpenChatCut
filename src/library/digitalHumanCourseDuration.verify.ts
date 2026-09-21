import assert from 'node:assert/strict';
import {
  distributeCourseSeconds,
  estimateCourseScriptSeconds,
  normalizeCourseDurationMinutes,
  targetCourseCharacters,
} from './digitalHumanCourseDuration';

assert.equal(normalizeCourseDurationMinutes(0), 0.5);
assert.equal(normalizeCourseDurationMinutes(3.2), 3);
assert.equal(normalizeCourseDurationMinutes(200), 120);
assert.equal(targetCourseCharacters(1), 240);
assert.equal(targetCourseCharacters(1, 1.5), 360);
assert.equal(estimateCourseScriptSeconds('一二三四五六七八'), 2);

const distributed = distributeCourseSeconds(['短', '这是一个明显更长的章节'], 60);
assert.equal(distributed.reduce((sum, seconds) => sum + seconds, 0), 60);
assert.ok(distributed[1] > distributed[0]);

console.log('digital human course duration verify passed');
