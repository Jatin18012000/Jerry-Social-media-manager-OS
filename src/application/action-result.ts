/**
 * The shape every server action returns.
 *
 * One definition rather than one per module: the UI treats these uniformly,
 * and two near-identical types would drift and collide the moment a component
 * used actions from both.
 */
export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
  /** Where to send the user on success, when the action creates something. */
  readonly redirectTo?: string;
}
