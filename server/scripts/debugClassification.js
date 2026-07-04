'use strict';
/**
 * debugClassification.js
 *
 * Developer-only verification script.
 * Loads the CPEN (or any) program graph from MongoDB, extracts requirement
 * evidence, and matches a list of test courses — without the full HTTP server.
 *
 * Usage:
 *   node scripts/debugClassification.js [programId] [course1] [course2] ...
 *
 * Example:
 *   node scripts/debugClassification.js bs-cpen:2025-2026 "CSCE 483" "ECEN 426" "CSCE 399" "STAT 404"
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

async function main() {
  const args = process.argv.slice(2);
  const programId  = args[0] ?? 'bs-cpen:2025-2026';
  const testCourses = args.length > 1
    ? args.slice(1)
    : ['CSCE 399', 'CSCE 442', 'CSCE 483', 'ECEN 426', 'ENGR 450', 'STAT 404'];

  console.log(`\n=== Classification Debug ===`);
  console.log(`Program:  ${programId}`);
  console.log(`Courses:  ${testCourses.join(', ')}\n`);

  await mongoose.connect(process.env.MONGO_URI ?? process.env.MONGODB_URI ?? 'mongodb://localhost:27017/zlp');

  const { getDegreeRequirementGraph } = require('../src/lib/degreeGraphBuilder');
  const { extractRequirementEvidence, matchCourseToEvidence } = require('../src/lib/degreeRequirementEvidence');

  const graph    = await getDegreeRequirementGraph(programId);
  const evidence = extractRequirementEvidence(graph);

  // --- Evidence bundle summary ---
  console.log(`--- Evidence Bundle for ${programId} ---`);
  console.log(`  hasData:              ${evidence.hasData}`);
  console.log(`  exactRequiredCourses: ${evidence.exactRequiredCourses.length}`);
  console.log(`  seniorDesignGroups:   ${evidence.seniorDesignGroups.length}`);
  console.log(`  requiredChoiceGroups: ${evidence.requiredChoiceGroups.length}`);
  console.log(`  pickNGroups:          ${evidence.pickNGroups.length}`);
  console.log(`  genericPlaceholders:  ${evidence.genericPlaceholders.length}`);
  console.log(`  graph warnings:       ${evidence.warnings.length}`);
  if (evidence.warnings.length > 0) {
    evidence.warnings.forEach((w) => console.log(`    ⚠ ${w}`));
  }

  if (evidence.seniorDesignGroups.length > 0) {
    console.log(`\n  Senior Design Groups:`);
    evidence.seniorDesignGroups.forEach((g) => {
      console.log(`    [${g.id}] label="${g.label}" groupRule="${g.groupRule}" codes=[${g.codes.join(', ')}]`);
    });
  }

  if (evidence.requiredChoiceGroups.length > 0) {
    console.log(`\n  Required Choice Groups (first 5):`);
    evidence.requiredChoiceGroups.slice(0, 5).forEach((g) => {
      console.log(`    [${g.id}] label="${g.label}" groupRule="${g.groupRule}" codes=[${g.codes.join(', ')}]`);
    });
  }

  console.log(`\n--- Course Match Results ---`);
  for (const courseCode of testCourses) {
    const match = matchCourseToEvidence(courseCode, evidence);
    if (!match) {
      console.log(`\n  ${courseCode}:`);
      console.log(`    match type:     NO MATCH`);
      console.log(`    expected class: not_applied`);
    } else {
      console.log(`\n  ${courseCode}:`);
      console.log(`    match type:     ${match.type}`);
      console.log(`    confidence:     ${match.confidence}`);

      if (match.type === 'exact_required') {
        console.log(`    node code:      ${match.item.code ?? '(none)'}`);
        console.log(`    all codes:      [${match.item.allCodes.join(', ')}]`);
        console.log(`    title:          ${match.item.title}`);
        console.log(`    expected class: required`);
      } else if (match.type === 'senior_design') {
        console.log(`    group label:    ${match.item.label}`);
        console.log(`    group rule:     ${match.item.groupRule}`);
        console.log(`    codes in group: [${match.item.codes.join(', ')}]`);
        const isSingle = match.item.groupRule === 'required_single' || match.item.codes.length === 1;
        console.log(`    expected class: ${isSingle ? 'required' : 'preferred'}`);
        console.log(`    reason:         ${isSingle
          ? `Required: ${courseCode} is the required senior design/capstone course`
          : `Preferred: ${courseCode} is one option for the required senior design/capstone requirement`}`);
      } else if (match.type === 'required_choice') {
        console.log(`    group label:    ${match.item.label}`);
        console.log(`    group rule:     ${match.item.groupRule}`);
        console.log(`    codes in group: [${match.item.codes.join(', ')}]`);
        console.log(`    expected class: preferred`);
      } else if (match.type === 'pick_n') {
        console.log(`    group label:    ${match.item.label}`);
        console.log(`    pick count:     ${match.item.pickCount}`);
        console.log(`    codes in group: [${match.item.codes.join(', ')}]`);
        console.log(`    expected class: preferred`);
      }
    }
  }

  console.log(`\n--- Raw Graph Nodes matching test courses ---`);
  for (const courseCode of testCourses) {
    const [subj, num] = courseCode.split(' ');
    const matches = graph.nodes.filter((n) => {
      const directMatch = n.code === courseCode;
      const inMatches   = (n.matches ?? []).some((m) => (typeof m === 'string' ? m : m.code) === courseCode);
      return directMatch || inMatches;
    });
    if (matches.length === 0) {
      console.log(`  ${courseCode}: no graph nodes`);
    } else {
      for (const n of matches) {
        console.log(`  ${courseCode}: node[${n.id}] type="${n.requirementType}" title="${n.title}" code="${n.code}" matches=[${(n.matches ?? []).join(', ')}]`);
      }
    }
  }

  console.log('');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
