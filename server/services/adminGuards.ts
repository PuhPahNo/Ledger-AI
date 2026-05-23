export function canSetAdminActive(input: {
  targetCurrentlyActive: boolean;
  nextActive: boolean;
  remainingActiveAdmins: number;
}): boolean {
  if (input.nextActive) return true;
  if (!input.targetCurrentlyActive) return true;
  return input.remainingActiveAdmins > 0;
}
