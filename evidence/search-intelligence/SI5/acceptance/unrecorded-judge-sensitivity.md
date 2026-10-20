# Does the unrecorded second-round judge matter?

The judge of 33 of the second round's 96 queries was not recorded (their transcripts were lost), so neither its model nor whether it stayed inside its packet can be audited (`eval/judges.json`, `rounds.second.unrecorded`; `eval/labels.json` lists the 33 beside the 63 queries judged through the recorded API judge). A second label only decides which documents go to adjudication: the first judge's grade stands unless the two disagree and an adjudicator decides. A second judge that had seen the first judge's labels would therefore agree more often, send fewer documents to adjudication, and leave more first-judge grades standing.

The bound comes from taking that to its end. On the 33 queries (1,430 documents, 78 of them carrying an adjudicated label) every grade is reset to the first judge's, which removes everything the unrecorded judge and the adjudications of its disputes contributed, and the 96 held-out queries are scored again with the project's scorer. 42 of the 1,430 grades differ from the first judge's and are the ones reset.

| | As recorded | First judge only on the 33 |
|---|---|---|
| nDCG@10 A / B / C / D | 0.5000 / 0.6271 / 0.7330 / 0.7370 | 0.4982 / 0.6251 / 0.7318 / 0.7358 |
| Q01 relative improvement, D over A | +47.4% | +47.7% |
| Q01 recall@20 gain | +39.2 points | +39.6 points |
| Q02 nDCG@10 difference, C over B | +0.1059 | +0.1067 |
| Q03 coverage difference, D over C | +1.94 points | +1.94 points |

No gate status changes, and no figure moves by more than 0.4 points. The conclusions of Q01, Q02 and Q03 do not depend on the unrecorded judge. What stays unauditable is that judge's model and containment; this note bounds what it could have changed, it does not recover it.

Method: a transient copy of `eval/labels.json` with those grades reset, `node scripts/si5/score.mjs`, then both files restored from git (the committed `labels.json` and `scores.json` are the recorded ones).
