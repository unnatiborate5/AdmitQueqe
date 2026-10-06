# AdmitFlow queue engine (C++17)

The core of Phase 4: token generation and queue management for physical document verification.
No third-party libraries. The three data structures are written from scratch (not wrappers around the STL).

```
cpp_engine/
├── include/dsa/fifo_queue.hpp   FifoQueue  (linked-list queue)
├── include/dsa/min_heap.hpp     MinHeap    (binary heap = priority queue)
├── include/dsa/hash_map.hpp     HashMap    (separate chaining + rehashing)
├── include/queue_engine.hpp     the engine: lanes, counters, token lifecycle, fairness rule
├── include/protocol.hpp         text protocol used by the Node backend
├── src/queue_engine.cpp         engine logic
├── src/protocol.cpp, main.cpp   the `queue_engine` process (stdin -> JSON on stdout)
└── tests/test_engine.cpp        27 unit tests (657 checks)
```

## Where each data structure is used, and why

| Structure | Where (file, member) | What it does | Why this structure | Cost |
|---|---|---|---|---|
| **Queue** `FifoQueue` | `queue_engine.hpp` `regularLane_` | The REGULAR waiting lane. Students with no priority are called strictly in the order they checked in. | A FIFO queue *is* "first come, first served". Head/tail pointers make enqueue and dequeue constant time. `removeIf` takes out a student who cancels; `insertSorted` puts a student back at their ORIGINAL place when a counter is closed (nobody loses their turn). | push/pop O(1), remove O(n) |
| **Priority queue** `MinHeap` | `queue_engine.hpp` `priorityLane_` | The PRIORITY waiting lane, ordered by (priority level, arrival number). | The next student must be the most urgent of all waiting priority students, and new ones keep arriving. A heap gives push/pop in O(log n); keeping a sorted list would cost O(n) per arrival. Ties are broken by arrival number, so students with the same priority are served fairly (first come, first served). Cancelled students are skipped lazily (a heap cannot delete from the middle cheaply). | push/pop O(log n), peek O(1) |
| **Hash map** `HashMap` | `tokens_` : token code -> token | Every desk action (start, complete, no-show, cancel, lookup) arrives with a token code, not a queue position. | O(1) average lookup instead of scanning both lanes. | O(1) avg |
| | `appIndex_` : application ID -> active token code | (a) Lookup by application ID. (b) **Duplicate-token prevention**: a student with an active token is found immediately and a second token is refused. | One map serves both needs, so the duplicate check costs nothing extra. | O(1) avg |
| | `counters_` : counter id -> counter | Counter state (open/closed, current student). | Each call/close needs that counter by id. | O(1) avg |

Nothing is there "for show": remove the heap and priorities disappear; remove the FIFO and regular order is lost;
remove `appIndex_` and duplicate checks and application-ID lookups become linear scans.

## Priority policy (decided in the backend from existing admission data, enforced here)

| Level | Lane | Who |
|---|---|---|
| 1 | Priority (heap) | Verification already started (status "In progress"): the student is coming back to finish it |
| 2 | Priority (heap) | CAP round is Round 3 or Special Round: less time is left to complete admission |
| 3 | Regular (FIFO) | Everyone else |

## Call order (the fairness rule)

1. Call the next priority student (lowest level first, then earliest arrival), **unless**
2. `fairness` priority students (default 3, env `QUEUE_PRIORITY_BURST`) were just called in a row **and** a regular
   student is waiting: then call the oldest regular student.

So priority students go first, equal priorities are served in arrival order, and the regular lane can never starve.
`QueueEngine::callOrder()` simulates this same rule on a copy of the lanes, which is how queue positions are shown;
a test checks that the promised order equals the order students are actually called.

## Token lifecycle

```
check-in -> WAITING --call--> CALLED --start--> SERVING --complete--> (done)
               |                |
               |                +--no-show--> (done)      student may get a NEW token (goes to the back)
               +--cancel--> (done)             counter closed while CALLED: back to WAITING, original place
```

The engine holds only active tokens; finished ones live in the database. The backend can rebuild the engine from the
database at any time (`RESET`, `COUNTER`, `LOAD`, `SEQ`, `STREAK` commands), which is how restarts and crashes are handled.

## Build and test

`npm start` and `npm test` (in `backend/`) compile the engine automatically with g++ / clang++ (see `backend/scripts/buildEngine.js`).
By hand: `cd cpp_engine && make test`. Protocol reference: `include/protocol.hpp`.
