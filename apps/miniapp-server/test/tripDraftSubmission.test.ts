import {test} from 'node:test';
import assert from 'node:assert/strict';
import {submissionDraftConflict,submissionSequence} from '../src/lib/tripDraftSubmission';
const working={state:'open',revision:5,payload:JSON.stringify({date:'2026-10-15',editingTripSeq:0})};
test('submission is bound to exact report/date and acknowledged revision',()=>{
 assert.equal(submissionDraftConflict(working,'2026-10-15',0,5,undefined,'new'),null);
 assert.equal(submissionDraftConflict(working,'2026-10-16',0,5,undefined,'new'),'identity');
 assert.equal(submissionDraftConflict(working,'2026-10-15',1,5,undefined,'new'),'identity');
 assert.equal(submissionDraftConflict(working,'2026-10-15',0,4,undefined,'new'),'revision');
});
test('only the identical lost-response retry may use an archived submission',()=>{
 const archived={...working,state:'archived',revision:6};
 assert.equal(submissionDraftConflict(archived,'2026-10-15',0,5,'saved','saved'),null);
 assert.equal(submissionDraftConflict(archived,'2026-10-15',0,5,'saved','another'),'revision');
});
test('stable draft identity prevents duplicate trip sequence on retries, preserving explicit edits',()=>{
 assert.equal(submissionSequence(undefined,2,undefined,[0,1,2]),2);
 assert.equal(submissionSequence(0,undefined,undefined,[0,1,2]),0);
 assert.equal(submissionSequence(undefined,undefined,2,[0,1,2]),2);
 assert.equal(submissionSequence(undefined,undefined,undefined,[0,1,2]),3);
});
