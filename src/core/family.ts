// Family-group configuration for the synthetic demo. A firm liaises with one person per
// family group and sends as few emails as possible; this is who that person is and how
// we greet them. Configuration, not workspace state — nothing here is persisted.

export type FamilyGroup = {
  id: string; name: string;
  liaison: { name: string; firstName: string; email: string; role: string };
  entityIds: string[];
};

export const FAMILY_GROUPS: FamilyGroup[] = [{
  id: 'taylor-family', name: 'Taylor family',
  liaison: { name: 'Alan Taylor', firstName: 'Alan', email: 'taylorfamilyexample@gmail.com', role: 'Trustee and family contact (synthetic)' },
  entityIds: ['alex-taylor', 'sam-taylor', 'taylor-services', 'taylor-family-trust'],
}];

export function groupFor(entityId: string): FamilyGroup | undefined {
  return FAMILY_GROUPS.find(g => g.entityIds.includes(entityId));
}

export type Season = 'summer' | 'autumn' | 'winter' | 'spring';

/** Australian seasons: Dec–Feb summer, Mar–May autumn, Jun–Aug winter, Sep–Nov spring. */
export function seasonOf(date: Date): Season {
  const month = date.getMonth();
  if (month === 11 || month <= 1) return 'summer';
  if (month <= 4) return 'autumn';
  if (month <= 7) return 'winter';
  return 'spring';
}

const SEASON_LINE: Record<Season, string> = {
  summer: "you're keeping cool this summer",
  autumn: 'autumn is treating you well',
  winter: "you're keeping warm this winter",
  spring: 'spring is treating you and the family kindly',
};

export function greeting(firstName: string, kind: 'initial' | 'reminder', date: Date) {
  const line = SEASON_LINE[seasonOf(date)];
  return kind === 'reminder'
    ? `Hi ${firstName},\n\nA gentle nudge from us — hope ${line}. A few items are still outstanding for FY2026, so here they are in one place, grouped by entity.`
    : `Hi ${firstName},\n\nHope you are well and that ${line}.\n\nTo keep this to a single email, here is everything we still need for FY2026 (1 July 2025–30 June 2026) across the family group, grouped by entity.`;
}
