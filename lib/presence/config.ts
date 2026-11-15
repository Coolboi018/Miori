// Shared presence config — kept separate so lib/presence modules never
// import each other in a cycle (discord <-> art).
export const DISCORD_APP_ID = '1527940752099901531';

// The presence card's IDENTITY.
//
// Discord does not update a card in place when this changes — it drops the old
// card and animates a new one in. That is the "the RPC disappears for a couple
// of seconds, then comes back with the new screen" report: one session, one
// OP3 per change, no clear on the wire, but the card is re-created because its
// identity moved. Browsing used to send `type: 0` ('Playing Miori') while every
// other screen sent `type: 3` carrying that screen's own title as the activity
// name, so EVERY navigation changed the identity.
//
// Both fields are fixed for the whole app now. Everything that actually varies
// per screen rides in `details`/`state`/`assets` — the fields Discord updates
// in place on the card that is already on screen.
export const APP_NAME = 'Miori';
/** 'Watching' — apt for an anime client, and one value for the whole app so
 * the Playing/Watching switch never re-creates the card. */
export const ACTIVITY_TYPE = 3;
