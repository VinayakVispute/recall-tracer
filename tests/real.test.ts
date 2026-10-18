import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { hazardsOf, statesIn, toRecall, loadReal, realOutbreaks, lotCodesIn, coverageOf, parseCaseReport, checkCaseReport } from '../src/data/real.js';
import { close } from '../src/graph/db.js';

describe('real data parsing', () => {
  it('names every hazard in a recall reason', () => {
    expect(hazardsOf('may be contaminated with E. coli and/or Salmonella (downstream recall)')).toEqual(['Salmonella', 'E. coli (STEC)']);
    expect(hazardsOf('Products may be contaminated with Listeria monocytogenes.')).toEqual(['Listeria monocytogenes']);
    expect(hazardsOf('Undeclared milk')).toEqual(['Undeclared allergen']);
    expect(hazardsOf('Mislabeled net weight')).toEqual(['Other']);
  });

  it('reads states from codes and names without double counting Virginia', () => {
    expect(statesIn('MD, VA, NY')).toEqual(['MD', 'NY', 'VA']);
    expect(statesIn('Distributed in West Virginia and Ohio')).toEqual(['OH', 'WV']);
    expect(statesIn('Virginia and West Virginia')).toEqual(['VA', 'WV']);
    expect(statesIn('Only in NY.')).toEqual(['NY']);
    expect(statesIn('Nationwide; through Amazon or direct to consumer')).toEqual([]);
  });

  it('maps an openFDA record to a Recall', () => {
    const r = toRecall({
      recall_number: 'H-1407-2026', event_id: '99887', recalling_firm: "TODD'S SEEDS LLC ", city: 'Cookeville', state: 'TN',
      country: 'United States', classification: 'Class I', status: 'Ongoing', product_description: 'Salad Sprouting Mixture',
      reason_for_recall: 'contain alfalfa seed recalled by the supplier and may be contaminated with E. coli and/or Salmonella (downstream recall)',
      code_info: 'Lot No: TS-633-2', product_quantity: '37,481 retail units', distribution_pattern: 'Nationwide; through Amazon',
      recall_initiation_date: '20260911', report_date: '20261007', voluntary_mandated: 'Voluntary: Firm initiated',
    });
    expect(r).toMatchObject({ firm: "TODD'S SEEDS LLC", initiated: '2026-09-11', reported: '2026-10-07', nationwide: true, downstream: true, states: [] });
  });

  it('reads lot codes, but not bare run numbers', () => {
    expect(lotCodesIn('ISS Lot # SAL2-24JB')).toEqual(['SAL2-24JB']);
    expect(lotCodesIn('Lot No: SAL2-24JB (1/4, 1/2, and 1 lb.); TS-1462-2.5-4 (2.5 lb. only)')).toEqual(['SAL2-24JB']);
    expect(lotCodesIn('Packages bear lot code SAL2-24JB on the label')).toEqual(['SAL2-24JB']);
    expect(lotCodesIn('Lot: AB123, CD456 and EF789')).toEqual(['AB123', 'CD456', 'EF789']);
    expect(lotCodesIn('LOT #222, 223, 225')).toEqual([]);
    expect(lotCodesIn('Use by 12/31/2029')).toEqual([]);
  });

  it('records which case states each recall reached first', () => {
    const r = (id: string, firm: string, initiated: string, states: string[], nationwide = false) =>
      ({ id, firm, initiated, states, nationwide, product: '', quantity: '', distribution: '', source: null });
    const { coverage, uncovered } = coverageOf(['FL', 'IA', 'MN', 'WA'], [r('B', 'Repacker', '2026-09-11', [], true), r('A', 'Supplier', '2026-08-23', ['FL', 'MN', 'CA'])]);
    expect(coverage.map((s) => [s.firm, s.added, s.total])).toEqual([['Supplier', ['FL', 'MN'], 2], ['Repacker', ['IA', 'WA'], 4]]);
    expect(uncovered).toEqual([]);
  });

  it('parses a case report and rejects bad rows', () => {
    const { outbreak, rejected } = parseCaseReport('pathogen,state,onset_from,onset_to\nSalmonella,FL,2026-05-31,2026-09-07\nSalmonella,XX,2026-05-31,2026-09-07');
    expect(outbreak).toMatchObject({ states: ['FL'], hazards: ['Salmonella'], onset_from: '2026-05-31' });
    expect(rejected.map((r) => r.row)).toEqual([3]);
    expect(() => parseCaseReport('state\nFL')).toThrow(/pathogen/);
  });
});

describe('real outbreak', () => {
  afterAll(close);

  it('finds Illinois as the state the Clover Hill recalls missed', async () => {
    await loadReal();
    const [o] = await realOutbreaks();
    expect(o).toMatchObject({ id: 'CDC-LISTERIA-SOFT-CHEESE-2026-06', cases: 15, shipped: ['MD', 'NY', 'VA'], gap: ['IL'] });
    expect(o.recalls).toHaveLength(18);
    expect(o.downstream.map((d) => [d.firm, d.recalls])).toEqual(expect.arrayContaining([['Nelson & Isa Lacteos LLC', ['H-1189-2026']], ['La Ceiba Foods Latin Market Inc.', []]]));
  });

  it('links the sprout case report to seed lot SAL2-24JB across three firms', async () => {
    const r = await checkCaseReport(readFileSync('web/public/samples/cdc-alfalfa-sprouts-2026.csv', 'utf8'));
    expect(r.outbreak.states).toHaveLength(16);
    expect(r.chains.map((c) => c.lot)).toEqual(['SAL2-24JB']);
    const [c] = r.chains;
    expect(c.coverage.map((s) => [s.date, s.firm, s.added.length])).toEqual([
      ['2026-08-23', 'International Sprout Holdings, Inc', 6], ['2026-09-11', "TODD'S SEEDS LLC", 10], ['2026-09-23', 'Berlin Seeds', 0]]);
    expect(c.coverage[0].added).toEqual(['FL', 'MN', 'NY', 'OR', 'PA', 'SC']);
    expect(c).toMatchObject({ uncovered: [], days_to_first: 84, days_to_last: 31 });
  });
});
