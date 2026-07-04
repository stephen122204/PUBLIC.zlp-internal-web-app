'use strict';
/**
 * engineeringPrograms.js
 * Utility to filter academic programs to College of Engineering entries.
 */
const { listAcademicPrograms, getAcademicProgram } = require('./academicPrograms');

function listEngineeringPrograms() {
  return listAcademicPrograms({ type: 'major' }).filter((p) => p.college === 'Engineering');
}

function getEngineeringProgram(programId) {
  const prog = getAcademicProgram(programId);
  if (prog.college !== 'Engineering') {
    const err = new Error('Not a College of Engineering program');
    err.statusCode = 404;
    throw err;
  }
  return prog;
}

module.exports = { listEngineeringPrograms, getEngineeringProgram };
