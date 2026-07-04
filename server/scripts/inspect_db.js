'use strict';
process.chdir('/Users/Stephen/Desktop/ZLP_APP/server');
require('dotenv').config();
const mongoose = require('mongoose');
const DRG = require('../src/models/DegreeRequirementGraph');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const docs = await DRG.find({}).lean();
  docs.forEach(function(d) {
    console.log('\n=== ' + d.programId + ' ===');
    console.log('title:', d.title);
    console.log('Total nodes:', (d.nodes || []).length);
    var choiceNodes = (d.nodes || []).filter(function(n) { return n.requirementType !== 'required'; });
    console.log('Choice/elective nodes:', JSON.stringify(choiceNodes.slice(0, 4), null, 2));
    var seniorNodes = (d.nodes || []).filter(function(n) {
      var s = JSON.stringify(n).toLowerCase();
      return s.includes('senior') || s.includes('483') || s.includes('capstone');
    });
    if (seniorNodes.length) console.log('Senior nodes:', JSON.stringify(seniorNodes, null, 2));
    console.log('flexibleRequirements count:', (d.flexibleRequirements || []).length);
    console.log('sample flexReqs:', JSON.stringify((d.flexibleRequirements||[]).slice(0,3), null, 2));
    console.log('warnings:', d.warnings);
  });
  await mongoose.disconnect();
}
run().catch(function(e) { console.error(e); process.exit(1); });
