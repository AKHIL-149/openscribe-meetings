// A made-up meeting (fictional people and project) so a new user can explore every screen before recording
// anything: summary, speakers, "unsure" lines, Ask and export. It contains no real data, and the summary below
// was written by hand, not by a model.
const L = (speaker, start, text, extra = {}) => ({ speaker, start, dur: Math.max(2, Math.round(text.length / 14)), text, ...extra });

export const SAMPLE = {
  title: 'Sample: Website relaunch sync',
  transcript: [
    L('Maya', 4, 'Okay, let\'s start. The goal today is to agree on the launch date for the new website and who owns what.'),
    L('Dev', 14, 'The build is basically done. I still need two days to fix the checkout page on phones.'),
    L('Maya', 27, 'Good. Priya, where are we with the copy?'),
    L('Priya', 32, 'The homepage and pricing copy are finished. The about page is still a draft, I can finish it by Wednesday.'),
    L('Tom', 46, 'Can I raise the pricing page? Legal wants the new refund wording on it before we publish.'),
    L('Maya', 58, 'Yes, that is a must. Tom, can you get the final wording from legal?'),
    L('Tom', 66, 'I will ask them today and send it to Priya by Tuesday.'),
    L('Dev', 78, 'If the copy lands Wednesday and checkout is fixed by Thursday, we could launch on Friday.', { uncertain: true }),
    L('Priya', 90, 'Friday works for me.'),
    L('Maya', 95, 'My worry is launching on a Friday. If something breaks, nobody is around over the weekend.'),
    L('Dev', 106, 'Fair point. Monday morning is safer, we would have the whole week to react.'),
    L('Tom', 118, 'Monday is fine for legal and for the marketing email.', { overlap: true, uncertain: true }),
    L('Maya', 126, 'Then it is decided: we launch on Monday the 24th, and Friday is a code freeze.'),
    L('Priya', 138, 'Should we tell the support team ahead of time? They will get questions about the new layout.'),
    L('Maya', 148, 'Good idea. Priya, can you write a short heads-up for support?'),
    L('Priya', 156, 'Yes, I will send it on Thursday.'),
    L('Dev', 164, 'One more thing, we need a plan to go back to the old site if the launch goes badly.', { uncertain: true }),
    L('Maya', 175, 'Dev, please own the rollback plan and share it before the freeze.'),
    L('Dev', 183, 'Will do. I will write it up on Thursday as well.'),
    L('Tom', 192, 'Budget-wise we are fine. The extra hosting cost is small.'),
    L('Maya', 202, 'Great. To recap: launch Monday the 24th, freeze on Friday, copy by Wednesday, legal wording by Tuesday, rollback plan and support note on Thursday. Thanks everyone.'),
  ],
  summary: {
    title: 'Website relaunch: launch date and owners',
    summary: 'The team agreed to launch the new website on Monday the 24th instead of Friday, to avoid a weekend with nobody available if something breaks. Friday becomes a code freeze. Remaining work is the about-page copy, the legal refund wording for the pricing page, the mobile checkout fix, a rollback plan and a note for the support team.',
    topics: ['Launch date', 'Mobile checkout fix', 'Legal refund wording', 'Rollback plan', 'Support heads-up'],
    decisions: ['Launch on Monday the 24th, not Friday.', 'Friday is a code freeze.'],
    actionItems: [
      { task: 'Get the final refund wording from legal and send it to Priya', owner: 'Tom', due: 'Tuesday' },
      { task: 'Finish the about-page copy', owner: 'Priya', due: 'Wednesday' },
      { task: 'Fix the checkout page on phones', owner: 'Dev', due: 'Thursday' },
      { task: 'Write the rollback plan', owner: 'Dev', due: 'Thursday' },
      { task: 'Send a heads-up about the new layout to support', owner: 'Priya', due: 'Thursday' },
    ],
    speakers: [
      { name: 'Maya', role: 'Runs the meeting', points: ['Pushed for a Monday launch', 'Assigned owners and recapped the plan'] },
      { name: 'Dev', role: 'Engineering', points: ['Needs two days for the checkout fix', 'Owns the rollback plan'] },
      { name: 'Priya', role: 'Copy and communication', points: ['Homepage and pricing copy are done', 'Will brief the support team'] },
      { name: 'Tom', role: 'Legal and budget contact', points: ['Is getting the refund wording from legal', 'Confirmed the budget is fine'] },
    ],
    engine: 'sample (written by hand, not by a model)',
  },
};
