# AdmitFlow queue engine (C++17)

The core of Phase 4: token generation and queue management for physical document verification.
No third-party libraries. The three data structures are written from scratch (not wrappers around the STL).

```
cpp_engine/
├── include/dsa/fifo_queue.hpp   FifoQueue    (linked-list queue)                         Phase 4
├── include/dsa/min_heap.hpp     MinHeap      (binary heap = priority queue)              Phase 4
├── include/dsa/hash_map.hpp     HashMap      (separate chaining + rehashing)             Phase 4
├── include/queue_engine.hpp     the queue engine: lanes, counters, token lifecycle       Phase 4
├── include/protocol.hpp         queue text protocol                                      Phase 4
├── include/algo/merge_sort.hpp  mergeSort    (stable, O(n log n))                        Phase 5
├── include/algo/search.hpp      lowerBound / upperBound (binary), linearSearchAll        Phase 5
├── include/dsa/stack.hpp        Stack        (array based, optionally bounded)           Phase 5
├── include/dsa/sparse_matrix.hpp SparseMatrix (triplet list, sorted)                     Phase 5
├── include/dsa/dense_matrix.hpp DenseMatrix  (contiguous row-major array)                Phase 5
├── include/search_index.hpp     SearchIndex: application ID / token / name search        Phase 5
├── include/planner.hpp          worklist ranking comparators                             Phase 5
├── include/undo_stacks.hpp      UndoStacks: HashMap(admin) -> Stack(actions)             Phase 5
├── include/reports.hpp          appointment-load (sparse) and document-readiness (dense) Phase 5
├── include/toolkit.hpp          Toolkit = queue engine + all Phase 5 features
├── src/*.cpp                    implementations; main.cpp is the `queue_engine` process (stdin -> JSON on stdout)
├── tests/test_engine.cpp        Phase 4 unit tests (27 tests, 657 checks)
└── tests/test_toolkit.cpp       Phase 5 unit tests (21 tests, 613 checks)
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

## Phase 5: syllabus features (searching, sorting, stack, matrices)

All of it lives in this engine and is reached through the same stdin/stdout process as the queue (commands in `include/toolkit.hpp`).
The Phase 4 queue code was not changed; `handleToolkitLine` answers the new commands and passes every other line to the original `handleLine`.

| Concept | Algorithm / structure | File | Real use in AdmitFlow | Why this one |
|---|---|---|---|---|
| **Searching** | **Binary search** (`lowerBound`, `upperBound`) | `algo/search.hpp`, used by `search_index.cpp` and `sparse_matrix.hpp` | Admin search box: type an application ID or a prefix (`MH2026-100`) and the matching students form one contiguous range of a sorted array; type a token (`R012`) and it is found by number in today's sorted tokens | The data is sorted by the very key being searched, so each step halves the range: ~12 steps for 4,000 students instead of 4,000 |
| | **Linear search** (`linearSearchAll`) | `algo/search.hpp`, `SearchIndex::findByName` | Same search box, for a name fragment (`kul` finds Meera Kulkarni) | A fragment inside a name has no sort order to exploit, so every record must be examined. The scan count is reported to show the difference |
| **Sorting** | **Merge sort** (stable, O(n log n)) | `algo/merge_sort.hpp`; used by `search_index.cpp`, `planner.cpp`, `reports.cpp` | (1) Sorts the search index so binary search is possible. (2) Planner page: ranks students who still need an appointment (priority level, then longest waiting, then name) and orders today's appointments by time, priority or queue token. (3) Ranks the busiest appointment slots | Several keys with ties must give the same order every time, so the sort has to be stable. Merge sort is stable and has no bad case (quick sort is neither stable nor safe on already-ordered input such as a day's tokens) |
| **Stack** | `Stack<T>` (push, pop, peek, bounded) inside `UndoStacks` (one stack per admin in a `HashMap`) | `dsa/stack.hpp`, `undo_stacks.hpp` | Undo for the admin's recent reversible changes: application decisions and appointment reschedules. The newest change is always undone first | Undo is last-in-first-out by nature: reversing an older change under a newer one would corrupt the record. Capacity 20 per admin; the oldest entry falls off |
| **Sparse matrix** | Triplet (row, col, value) list kept sorted, found by binary search | `dsa/sparse_matrix.hpp`, `reports.cpp` | Appointment load: days x 48 half-hour slots, counting booked students per cell. Shows busy slots and suggests the least busy slot when scheduling | A 31-day x 48-slot grid has 1,488 cells but a college books a few dozen appointments (over 95% zeros). Only booked cells are stored |
| **Dense matrix** | Contiguous row-major array | `dsa/dense_matrix.hpp`, `reports.cpp` | Document readiness: 9 documents x 4 CAP rounds, each cell = students of that round who have that document ready. Shows the weakest document per round | Small fixed grid where every cell is a real number (a 0 means "nobody has it yet"). Direct index access, and row/column sums are plain loops |

Each search and sort reports how many comparisons it made, and the unit tests check those counts (binary search stays near log2 n; linear search equals n; merge sort stays within n log2 n).

### What the engine is deliberately NOT used for: CAP record lookup
CAP allotment records are looked up by application ID with SQLite's `UNIQUE` index, not with an engine hash map. The database lookup is already O(log n), is the single source of truth, and enforces "no duplicate application IDs" inside the same transaction that links a student. A copy in the engine would duplicate the data, need syncing, and could be stale when it matters. The engine's search index (binary search by application ID) only serves the admin search box, only contains verified and linked students, and no authentication or authorisation decision ever depends on it.

### What the matrices are NOT used for
Other places a matrix could be forced in (a student x student grid, a counter x student grid, a status transition table) were deliberately left out: they are either tiny, fully known in advance, or would not be read as a matrix by anything. Only the two uses above have data that is naturally two-dimensional and are actually shown to staff.

### How search keeps up with changing data
The Node backend loads the index into the engine (`INDEX_ADD`, `INDEX_TOKENS`, `INDEX_BUILD`) and rebuilds it only when a fingerprint of the data changes (student count, CAP updates, today's tokens). The undo stacks are rebuilt from the database whenever the engine starts, like the queue itself.

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

`npm start` and `npm test` (in `backend/`) compile the engine (every `src/*.cpp`) automatically with g++ / clang++ (see `backend/scripts/buildEngine.js`).
By hand: `cd cpp_engine && make test` (runs `test_engine` and `test_toolkit`). Protocol reference: `include/protocol.hpp`.
