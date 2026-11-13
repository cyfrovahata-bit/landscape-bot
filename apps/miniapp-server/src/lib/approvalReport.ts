type ApprovalReportTotals = {combined:{salaryPacks:{objectName:string;objectTotal:number;rows:{employeeName:string;pay:number}[]}[];roadAllowance:{perPerson:number};deductions:{items:{reason:string;amount:number}[];total:number}}};
/** Telegram's legacy Markdown breaks on unescaped _ * [ ` in the text, and a
 * broken message is silently rejected by the API -- which for a payout
 * summary means the foreman just never hears about their money. Object and
 * employee names come from the office's spreadsheets, so they can contain
 * anything. */
function escapeMd(s: string): string {
  return s.replace(/([_*[\]`])/g, "\\$1");
}

export function money(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * The short payout note a foreman gets the moment an admin approves their
 * day: which object, who earned how much there, and the day's total fund.
 * Deliberately brief -- the itemised view (hours, works, volumes, per-object
 * funds) is the ADMIN's, on the approval screen they act from. This is just
 * the outcome, for the person who has to tell the crew what they made.
 *
 * `pay` in a salary pack row is already role-adjusted (the brigadier's 20%
 * and the senior gardener's 10% come off the top, the rest splits between
 * workers by hours), so the rows as listed ARE the real per-person work pay.
 * The travel allowance is per-person and separate from the object funds, so
 * it stays its own line instead of being folded into those numbers -- drop
 * it and the amounts stop adding up to what people actually receive.
 */
export function buildApprovalReport(date: string, totals: ApprovalReportTotals): string {
  const { combined } = totals;
  const packs = combined.salaryPacks.filter((p) => p.objectTotal > 0 || p.rows.length > 0);
  const totalFund = packs.reduce((acc, p) => acc + p.objectTotal, 0);

  const head = [`✅ *День затверджено*`, `📅 ${date}`, ``];
  const foot = [
    `➕ Доплата за виїзд: ${money(combined.roadAllowance.perPerson)} грн/особу`,
    `💰 *Загальний фонд: ${money(totalFund)} грн*`,
  ];

  const perObject = (withPeople: boolean) =>
    packs.flatMap((pack) => {
      const lines = [`📍 *${escapeMd(pack.objectName)}*`];
      if (withPeople) {
        if (!pack.rows.length) lines.push(`  _немає годин — оплата не розподілена_`);
        for (const row of pack.rows) lines.push(`  • ${escapeMd(row.employeeName)} — ${money(row.pay)} грн`);
      }
      lines.push(``);
      return lines;
    });

  // Telegram rejects anything over 4096 characters outright. At this size
  // that needs a truly enormous day, but if it ever happens the note sheds
  // the per-person lines rather than its tail -- the total fund is the whole
  // point of the message and always survives.
  const LIMIT = 3900;
  const note = [`_Деталі скорочено — повний розклад у застосунку._`, ``];
  const variants = [
    [...head, ...perObject(true), ...foot],
    [...head, ...perObject(false), ...note, ...foot],
    [...head, ...note, ...foot],
  ];
  const chosen = variants.find((v) => v.join("\n").length <= LIMIT) ?? variants[variants.length - 1];
  return chosen.join("\n").slice(0, LIMIT);
}

