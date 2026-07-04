/**
 * transcriptParser.js
 *
 * Ported from reference/tamu-course-offering-history/public/planner-transcript-parser.js
 * Parses TAMU unofficial transcript text and degree plan text into structured course data.
 * Reference is READ-ONLY — this is the app's own copy adapted for ES module use in Vite.
 */

const TERM_PATTERN = /^(Fall|Spring|Summer) \d{4} - /;
const SUBJECT_PATTERN = /^[A-Z]{3,5}$/;
const COURSE_NUMBER_PATTERN = /^\d{3}[A-Z]?$/;
const INLINE_COURSE_PATTERN = /^([A-Z]{3,5})\s+(\d{3}[A-Z]?)\b(?:\s+(.*))?$/;
const GRADE_PATTERN = /^(A|B|C|D|F|S|U|Q|P|CR|TCR|TA|TB|TC|TR|I|W)$/;
const DECIMAL_PATTERN = /^\d+\.\d{3}$/;
const TITLE_NOISE_PATTERN =
  /\b(?:UNOFFICIAL(?:\s+(?:ACADEMIC\s+RECORD|TRANSCRIPT))?|TRANSCRIPT\s+TOTALS|TOTAL\s+INSTITUTION|TOTAL\s+TRANSFER|OVERALL|EARNED\s+HRS|GPA\s+HRS|POINTS|COLLEGE\s+STATION\s+TEXAS\s+77843|TEXAS\s+A&M\s+UNIVERSITY)\b/i;

const NOISE_EXACT = new Set([
  'UNOFFICIAL ACADEMIC RECORD',
  'TEXAS A&M UNIVERSITY',
  'COLLEGE STATION TEXAS 77843',
  'CURRICULUM INFORMATION',
  'INSTITUTION CREDIT',
  'TRANSFER CREDITS ACCEPTED BY INSTITUTION',
  'CREDENTIAL(S) AWARDED',
  'COURSES IN PROGRESS',
  'TRANSCRIPT TOTALS',
  'TOTAL INSTITUTION',
  'TOTAL TRANSFER',
  'TOTAL',   // section-total row (e.g. "TOTAL 116") — not a course subject
  'OVERALL',
  'Semester',
  'Subj',
  'No.',
  'Course Title',
  'Grade',
  'Cred',
  'Pts',
  'Earned Hrs',
  'GPA Hrs',
  'Points',
  'GPA',
  'R', 'OF', 'UN', 'PT', 'SC', 'RI', 'RA', 'N', 'FI', 'CI', 'AL', 'T',
]);

const NOISE_PREFIXES = [
  'Name:', 'Page ', 'Ehrs:', 'GPA-Hrs:', 'Qpts:', 'GPA:',
  'Current Program:', 'College:', 'Major:', 'Minor:', 'Department:',
  'Term Totals', 'Undergraduate Totals', 'Graduate Totals',
  'TOTAL ',  // "TOTAL 116" — section credit-hour totals, not courses
];

const PASSING_GRADES = new Set(['A', 'B', 'C', 'D', 'S', 'P', 'CR', 'TCR', 'TA', 'TB', 'TC', 'TR']);

export function normalizeCourseCode(subject, number) {
  return `${String(subject ?? '').trim().toUpperCase()} ${String(number ?? '').trim()}`.trim();
}

function parseDegreePlanTermKey(termLine) {
  const match = String(termLine ?? '').match(/^(\d{4}) - (Fall|Spring|Summer)$/);
  if (!match) return null;
  const seasonRank = { Spring: 1, Summer: 2, Fall: 3 };
  return { year: Number(match[1]), season: match[2], value: Number(match[1]) * 10 + seasonRank[match[2]] };
}

function getCurrentDegreePlanTermKey(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const season = month <= 4 ? 'Spring' : month <= 7 ? 'Summer' : 'Fall';
  return parseDegreePlanTermKey(`${year} - ${season}`);
}

function sanitizeCourseTitle(title) {
  const normalized = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const firstNoiseMatch = normalized.match(TITLE_NOISE_PATTERN);
  const clipped = firstNoiseMatch ? normalized.slice(0, firstNoiseMatch.index).trim() : normalized;
  return clipped.replace(/\s+/g, ' ').trim();
}

function uniq(items) {
  return [...new Set(items.filter(Boolean))];
}

function isNoiseLine(line) {
  if (!line) return true;
  if (NOISE_EXACT.has(line)) return true;
  return NOISE_PREFIXES.some((prefix) => line.startsWith(prefix));
}

function isSubjectLine(line) {
  return SUBJECT_PATTERN.test(line) && !NOISE_EXACT.has(line);
}

function parseInlineCourseStart(line) {
  const match = String(line ?? '').match(INLINE_COURSE_PATTERN);
  if (!match) return null;
  if (NOISE_EXACT.has(match[1])) return null;  // e.g. "TOTAL 116" — not a course
  return { subject: match[1], number: match[2], remainder: match[3]?.trim() ?? '' };
}

function isCourseStart(lines, index) {
  return (
    (isSubjectLine(lines[index]) && COURSE_NUMBER_PATTERN.test(lines[index + 1] ?? '')) ||
    Boolean(parseInlineCourseStart(lines[index]))
  );
}

function parseMetadata(text) {
  const lines = cleanLines(text);
  const nameLine = lines.find((line) => line.startsWith('Name:')) ?? '';
  const nameMatch = nameLine.match(/^Name:\s*(.+?)\s+\((\d+)\)$/);
  const overallMatches = [...text.matchAll(/OVERALL\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)/g)];
  const overallMatch = overallMatches.at(-1) ?? null;
  const metadataValues = (prefix) =>
    uniq(
      lines
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length).trim())
        .filter(Boolean)
    );
  return {
    studentName: nameMatch?.[1]?.trim() ?? null,
    studentId: nameMatch?.[2]?.trim() ?? null,
    currentPrograms: metadataValues('Current Program:'),
    majors: metadataValues('Major:'),
    minors: metadataValues('Minor:'),
    overallGpa: overallMatch ? Number(overallMatch[4]) : null,
    earnedHours: overallMatch ? Number(overallMatch[1]) : null,
    gpaHours: overallMatch ? Number(overallMatch[2]) : null,
  };
}

function cleanLines(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function collectCoursePayload(lines, startIndex) {
  const inlineStart = parseInlineCourseStart(lines[startIndex]);
  const subject = inlineStart?.subject ?? lines[startIndex];
  const number = inlineStart?.number ?? lines[startIndex + 1];
  const payloadParts = [];
  let index = inlineStart ? startIndex + 1 : startIndex + 2;
  let sawGrade = false;
  let decimalCount = 0;

  if (inlineStart?.remainder) {
    payloadParts.push(inlineStart.remainder);
    inlineStart.remainder.split(/\s+/).forEach((token) => {
      if (GRADE_PATTERN.test(token)) sawGrade = true;
      if (DECIMAL_PATTERN.test(token)) decimalCount += 1;
    });
    if (sawGrade && decimalCount >= 2) {
      return { subject, number, payload: payloadParts.join(' ').replace(/\s+/g, ' ').trim(), nextIndex: index };
    }
  }

  while (index < lines.length) {
    const line = lines[index];
    if (
      TERM_PATTERN.test(line) ||
      line === 'TRANSFER CREDITS ACCEPTED BY INSTITUTION' ||
      line === 'INSTITUTION CREDIT' ||
      line === 'COURSES IN PROGRESS' ||
      isCourseStart(lines, index)
    ) break;

    if (GRADE_PATTERN.test(line)) { payloadParts.push(line); sawGrade = true; index += 1; continue; }
    if (DECIMAL_PATTERN.test(line)) {
      payloadParts.push(line); decimalCount += 1; index += 1;
      if ((sawGrade && decimalCount >= 2) || (!sawGrade && decimalCount >= 1)) break;
      continue;
    }
    if (!isNoiseLine(line)) payloadParts.push(line);
    index += 1;
  }
  return { subject, number, payload: payloadParts.join(' ').replace(/\s+/g, ' ').trim(), nextIndex: index };
}

function extractCourseFields(payload, sourceType) {
  const tokens = String(payload ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);

  // Strip trailing repeat indicator — TAMU transcripts have an 'R' column
  // (repeat flag) that ends up as the last token in the row text. It blocks
  // decimal/grade parsing if not removed first.
  while (tokens.length && (tokens.at(-1) === 'R' || tokens.at(-1) === 'NR')) tokens.pop();

  // 'I' can appear in the R column to mark an incomplete-retake. When 'I' is
  // the last token AND the two tokens before it are decimals, it is the R-column
  // marker (not the grade) and must be stripped so the actual grade ('A', 'B', …)
  // is parsed correctly.
  if (
    tokens.length >= 3 &&
    tokens.at(-1) === 'I' &&
    DECIMAL_PATTERN.test(tokens.at(-2)) &&
    DECIMAL_PATTERN.test(tokens.at(-3))
  ) {
    tokens.pop();
  }

  let points = null;
  let credits = null;
  let grade = null;

  if (sourceType === 'in-progress') {
    // Accept "3.000" (DECIMAL_PATTERN) or bare "3" (integer credit hours)
    const last = tokens.at(-1);
    if (last != null && /^\d+(?:\.\d+)?$/.test(last)) credits = Math.round(Number(tokens.pop()));
  } else {
    if (tokens.length >= 2 && DECIMAL_PATTERN.test(tokens.at(-1)) && DECIMAL_PATTERN.test(tokens.at(-2))) {
      points = Number(tokens.pop());
      credits = Math.round(Number(tokens.pop()));
    } else if (tokens.length && DECIMAL_PATTERN.test(tokens.at(-1))) {
      credits = Math.round(Number(tokens.pop()));
    }
    if (tokens.length && GRADE_PATTERN.test(tokens.at(-1))) grade = tokens.pop();
  }
  return { title: sanitizeCourseTitle(tokens.join(' ').trim()), grade, credits, points };
}

function parseCompletedCourse(lines, startIndex, term, sourceType) {
  const { subject, number, payload, nextIndex } = collectCoursePayload(lines, startIndex);
  const { title, grade, credits, points } = extractCourseFields(payload, sourceType);
  return {
    course: {
      term, sourceType, subject, number,
      code: normalizeCourseCode(subject, number),
      title, grade, credits, points,
      status: grade && PASSING_GRADES.has(grade) ? 'completed' : 'not-counted',
    },
    nextIndex,
  };
}

function parseInProgressCourse(lines, startIndex, term) {
  const { subject, number, payload, nextIndex } = collectCoursePayload(lines, startIndex);
  const { title, credits } = extractCourseFields(payload, 'in-progress');
  return {
    course: {
      term, sourceType: 'in-progress', subject, number,
      code: normalizeCourseCode(subject, number),
      title, grade: null, credits, points: null, status: 'in-progress',
    },
    nextIndex,
  };
}

function dedupeCourses(courses) {
  const seen = new Set();
  const deduped = [];
  for (const course of courses) {
    const sig = [course.term, course.code, course.grade ?? '', course.credits ?? '', course.sourceType].join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(course);
  }
  return deduped;
}

export function parseTranscriptText(text) {
  const metadata = parseMetadata(text);
  const lines = cleanLines(text);
  let currentTerm = null;
  let currentSourceType = 'institution';
  const allCourses = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === 'TRANSFER CREDITS ACCEPTED BY INSTITUTION') { currentSourceType = 'transfer'; index += 1; continue; }
    if (line === 'INSTITUTION CREDIT')   { currentSourceType = 'institution'; index += 1; continue; }
    if (line === 'COURSES IN PROGRESS')  { currentSourceType = 'in-progress'; index += 1; continue; }
    if (TERM_PATTERN.test(line)) { currentTerm = line; index += 1; continue; }
    if (line === 'TRANSCRIPT TOTALS') break;
    if (currentTerm && isCourseStart(lines, index)) {
      const parsed = currentSourceType === 'in-progress'
        ? parseInProgressCourse(lines, index, currentTerm)
        : parseCompletedCourse(lines, index, currentTerm, currentSourceType);
      if (parsed.course.title) allCourses.push(parsed.course);
      index = Math.max(parsed.nextIndex, index + 1);
      continue;
    }
    index += 1;
  }

  const deduped = dedupeCourses(allCourses);
  const completedCourses = deduped.filter((c) => c.status === 'completed');
  const inProgressCourses = deduped.filter((c) => c.status === 'in-progress');
  return {
    ...metadata,
    courses: deduped,
    completedCourses,
    inProgressCourses,
    completedCourseCodes: uniq(completedCourses.map((c) => c.code)),
    inProgressCourseCodes: uniq(inProgressCourses.map((c) => c.code)),
  };
}

export function parseDegreePlanText(text, now = new Date()) {
  const lines = cleanLines(text);
  const studentId = String(text ?? '').match(/\((\d{9})\)/)?.[1] ?? null;
  const programCode = lines.find((line) => /^B[AS]-[A-Z]+$/u.test(line)) ?? null;
  const currentTermKey = getCurrentDegreePlanTermKey(now);
  const courses = [];
  let currentTerm = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\d{4} - (Fall|Spring|Summer)$/u.test(line)) { currentTerm = line; continue; }
    if (!currentTerm) continue;

    const inlineStart = parseInlineCourseStart(line);
    const pairedStart =
      !inlineStart && isSubjectLine(line) && COURSE_NUMBER_PATTERN.test(lines[i + 1] ?? '')
        ? { subject: line, number: lines[i + 1], remainder: '' }
        : null;

    const start = inlineStart ?? pairedStart;
    if (!start) continue;

    const code = normalizeCourseCode(start.subject, start.number);
    const termKey = parseDegreePlanTermKey(currentTerm);
    if (!termKey || !currentTermKey) continue;
    if (termKey.value > currentTermKey.value) continue;

    courses.push({
      term: `${termKey.season} ${termKey.year} - Degree plan`,
      sourceType: termKey.value === currentTermKey.value ? 'in-progress' : 'institution',
      subject: start.subject,
      number: start.number,
      code,
      title: code,
      grade: termKey.value === currentTermKey.value ? null : 'PLN',
      credits: null,
      points: null,
      status: termKey.value === currentTermKey.value ? 'in-progress' : 'completed',
    });
  }

  const deduped = dedupeCourses(courses);
  const completedCourses = deduped.filter((c) => c.status === 'completed');
  const inProgressCourses = deduped.filter((c) => c.status === 'in-progress');
  return {
    studentName: null, studentId,
    currentPrograms: programCode ? [programCode] : [],
    majors: [], minors: [],
    overallGpa: null, earnedHours: null, gpaHours: null,
    courses: deduped, completedCourses, inProgressCourses,
    completedCourseCodes: uniq(completedCourses.map((c) => c.code)),
    inProgressCourseCodes: uniq(inProgressCourses.map((c) => c.code)),
  };
}
