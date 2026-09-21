/**
 * Domain errors.
 *
 * These are thrown by invariant guards. They are part of the domain contract:
 * the application layer is expected to catch them and surface them, never to
 * work around them.
 */

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Raised when a content item is asked to move between two states that the
 * transition table does not permit. See §38.
 */
export class IllegalTransitionError extends DomainError {
  constructor(
    readonly from: string,
    readonly to: string,
    reason?: string,
  ) {
    super(
      `Illegal content transition ${from} -> ${to}` +
        (reason ? `: ${reason}` : ''),
    );
  }
}

/**
 * Raised when a transition is structurally legal but its guard fails —
 * for example, entering PUBLISHED without evidence of publication.
 *
 * PRD §40: "Platform API fails -> do not mark content as published."
 */
export class InvariantViolationError extends DomainError {
  constructor(
    readonly invariant: string,
    message: string,
  ) {
    super(`Invariant violated (${invariant}): ${message}`);
  }
}
