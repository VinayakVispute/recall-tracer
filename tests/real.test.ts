import { describe, it, expect } from 'vitest';
import { hazardsOf, statesIn, toRecall } from '../src/data/real.js';

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
});
