/** User-supplied listening aid; not an official or verified operational codebook. */
export const nypdRadioReference = [
  'User-provided source context: NYPD Citywide 1 and 2 are described as carrying critical-incident traffic and citywide resource adjustments, with quiet periods between priority calls; some unclear calls may be repeated. Treat that description as unverified. Silence does not establish that nothing is happening, the feed must not be described as covering every incident, and a repeated transmission is not an independent corroborating source.',
  'This is a citywide background feed, not precinct-level coverage. The source description says Citywide 3 was removed from that volunteer scanner; do not infer Citywide 3 activity from this stream.',
  'Mobilization levels: Level One local borough task force; Level Two citywide task forces; Level Three local borough task force plus borough precinct personnel; Level Four citywide task forces plus precinct personnel citywide.',
  'Common: 10-1 call your command; 10-2 return to your command; 10-3 call dispatcher by telephone; 10-4 acknowledgment; 10-5 repeat; 10-6 standby; 10-7 verify address/location.',
  'Possible crime: 10-10. 10-11 alarm. 10-12 officer/security holding suspect. 10-13 assist officer. 10-14/10-15 plate checks; 10-16 vehicle reported stolen; 10-17 not reported stolen; 10-18 active warrant; 10-19 warrant check negative.',
  'Crime codes: 10-20/30 robbery; 10-21/31 burglary; 10-22/32 larceny; 10-33 explosive device/threat; 10-24/34 assault; 10-29/39 other crime.',
  'Non-crime and response: 10-40 panic alarm; 10-44 suspicious substance; 10-50 disorderly; 10-52 dispute; 10-53 vehicle accident; 10-54/55 ambulance case; 10-59 alarm of fire; 10-60 research.',
  'Other conditions: 10-65 utility trouble; 10-66 unusual incident; 10-67 traffic/parking condition; 10-68 see complainant; 10-69 other non-crime incident; 10-71 sex-offender address check; 10-75 visibility patrol.',
  'Interim status: 10-80 cancel; 10-81 highway tow; 10-82 verification/arrest; 10-83 report/notification at station; 10-84 arrived; 10-85 need additional unit; 10-87 unit to hospital; 10-88 vehicle pursuit; 10-89 other interim status.',
  'Disposition: 10-90 incident disposition; 10-91 non-crime corrected; 10-92 arrest; 10-93 complaint/no arrest; 10-94 handled by previous tour; 10-95 referred by another agency; 10-96 summons served; 10-97 ambulance disposition; 10-98 resuming patrol; 10-99 other final disposition.'
].join('\n');

export const nypdRadioInterpretationCaution = 'This is a user-provided, unverified listening aid, not an official codebook. Codes and subcodes can vary by context and may be outdated. Do not infer facts, urgency, guilt, identities, exact location, or breaking-news significance from a code alone; rely on the complete intelligible transcript and classify ambiguous content as routine.';
