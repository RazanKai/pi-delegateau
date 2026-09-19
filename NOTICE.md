# Provenance and attribution

This extension is independently implemented and does not require `pi-foreman` at
runtime.

The mode save/restore and fresh-process JSON-event ideas are adapted from
`rodh/pi-foreman` revision `e19a9ad9dce5c304e451e095e5899ddab00b3027`.
The exact upstream license is reproduced in `THIRD_PARTY_LICENSES/pi-foreman-MIT.txt`.
The current Pi subagent example was used as the process/event compatibility
reference. No pi-foreman workflow, planner, gates, validator, git, repo-map, or
repair-loop code is included.

`@tintinweb/pi-subagents` 0.19.0 was consulted for the mechanisms behind
package-aware extension naming and FIFO pool settlement. pi-delegateau's
implementation is independent and does not copy its code, but the reference is
MIT-licensed and its notice is retained in
`THIRD_PARTY_LICENSES/pi-subagents-MIT.txt`.
