Shared framing for NEGOTIATION: the goal is granular, testable criteria both
roles accept. Vague criteria produce vague critiques the generator shrugs off.
The evaluator later grades against THIS contract, not the original goal.

Every contract MUST include at least one criterion for automated tests covering
the sprint's behavior (tests written alongside the implementation, verified by
the test suite). A contract with no test criterion is under-scoped — the
evaluator rejects it during critique.

A contract has TWO parts. `criteria` are the behavioral ACCEPTANCE criteria — the
only thing the blind grader later scores. `scope` holds intent-level restrictions:
out-of-scope areas and where the change should stay ("changes stay within the
run-branch naming module and its tests; the voice pipeline is not touched"),
stated at directory/module granularity. Scope belongs in `scope`, NEVER as an
acceptance criterion. In particular, never write a criterion that closes the
change to an exact list or count of files ("only these 6 files", "no files other
than …", "git diff --name-only lists exactly N") — a change's true file set is not
knowable up front (a rename touches every test that hard-codes the old value; a
new field touches every construction site), so such a criterion contradicts "the
tests pass" and makes the contract unsatisfiable. Whether the edited file set is
appropriate is the SIGHTED critic's judgment during negotiation and the human's at
merge — not something the blind grader can or should enforce by counting files.

Keep the distinction sharp: a *scope* restriction constrains which files the diff
may touch (→ `scope`); a *behavioral* criterion that merely mentions files ("the
command lists only untracked files", "the parser accepts only .csv files")
constrains what the code does (→ `criteria`, and is perfectly fine).
