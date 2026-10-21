// AdmitFlow Reports Implementation
// Generates appointment load report (SparseMatrix) and document readiness report (DenseMatrix).

#include <iostream>
#include <string>
#include <vector>
#include <algorithm>
#include <utility>

#include "reports.h"
#include "algo/merge_sort.hpp"
#include "dsa/dense_matrix.hpp"
#include "dsa/sparse_matrix.hpp"

using namespace std;

namespace admitflow {

// Computes appointment load using a SparseMatrix (days x 30-min time slots)
bool computeAppointmentLoad(int totalDays, int totalSlots, int fromSlot, int toSlot,
                            const vector<pair<int, int>>& bookings,
                            LoadReport& outReport) {
  // Validate grid dimensions and time slot search range
  if (totalDays < 1 || totalSlots < 1 || fromSlot < 0 || toSlot > totalSlots || fromSlot >= toSlot) {
    return false;
  }

  // Populate sparse matrix with appointment bookings
  SparseMatrix<int> sparseMatrix(totalDays, totalSlots);
  for (const pair<int, int>& booking : bookings) {
    int dayIndex = booking.first;
    int slotIndex = booking.second;

    if (dayIndex < 0 || dayIndex >= totalDays || slotIndex < 0 || slotIndex >= totalSlots) {
      return false; // Booking outside grid boundary
    }
    sparseMatrix.add(dayIndex, slotIndex, 1);
  }

  // Build the output report
  outReport = LoadReport();
  outReport.rows = totalDays;
  outReport.cols = totalSlots;
  outReport.nonZeros = sparseMatrix.nonZeros();
  outReport.density = sparseMatrix.density();

  // Export non-zero cells in sorted row-major order
  for (const auto& entry : sparseMatrix.entries()) {
    outReport.cells.push_back(LoadCell{entry.row, entry.col, entry.value});
  }

  outReport.rowSums = sparseMatrix.rowSums();
  outReport.colSums = sparseMatrix.colSums();

  // Sort busiest cells using stable Merge Sort (descending by booking count)
  outReport.busiest = outReport.cells;
  mergeSort(outReport.busiest, [](const LoadCell& a, const LoadCell& b) {
    return a.count > b.count;
  });

  // Limit to top 5 busiest slots
  if (outReport.busiest.size() > 5) {
    outReport.busiest.resize(5);
  }

  // Find least loaded slot for each day within office hours [fromSlot, toSlot)
  for (int day = 0; day < totalDays; day++) {
    BestSlot bestSlotCandidate{-1, 0};

    for (int slot = fromSlot; slot < toSlot; slot++) {
      int currentCount = sparseMatrix.get(day, slot);

      if (bestSlotCandidate.col < 0 || currentCount < bestSlotCandidate.count) {
        bestSlotCandidate = BestSlot{slot, currentCount};
      }
    }
    outReport.bestSlots.push_back(bestSlotCandidate);
  }

  outReport.lookupComparisons = sparseMatrix.lookupComparisons();
  return true;
}

// Computes document readiness using a DenseMatrix (documents x CAP rounds)
bool computeDocReadiness(int documentCount, int roundCount,
                         const vector<int>& roundTotals,
                         const vector<DocCount>& cells,
                         ReadinessReport& outReport) {
  // Validate dimensions and round total vector size
  if (documentCount < 1 || roundCount < 1 || static_cast<int>(roundTotals.size()) != roundCount) {
    return false;
  }

  // Populate dense 2D matrix
  DenseMatrix<int> denseMatrix(static_cast<size_t>(documentCount),
                               static_cast<size_t>(roundCount));

  for (const DocCount& cell : cells) {
    if (cell.doc < 0 || cell.doc >= documentCount ||
        cell.round < 0 || cell.round >= roundCount || cell.count < 0) {
      return false;
    }
    denseMatrix.at(static_cast<size_t>(cell.doc),
                   static_cast<size_t>(cell.round)) += cell.count;
  }

  outReport = ReadinessReport();
  outReport.docs = documentCount;
  outReport.rounds = roundCount;
  outReport.roundTotals = roundTotals;

  for (int docIndex = 0; docIndex < documentCount; docIndex++) {
    outReport.docTotals.push_back(denseMatrix.rowSum(static_cast<size_t>(docIndex)));

    for (int roundIndex = 0; roundIndex < roundCount; roundIndex++) {
      int count = denseMatrix.at(static_cast<size_t>(docIndex),
                                 static_cast<size_t>(roundIndex));
      outReport.counts.push_back(count);

      int totalInRound = roundTotals[static_cast<size_t>(roundIndex)];
      double percentage = (totalInRound > 0) ? (100.0 * count / totalInRound) : 0.0;
      outReport.percent.push_back(percentage);
    }
  }

  // Determine weakest and strongest document for each round
  for (int roundIndex = 0; roundIndex < roundCount; roundIndex++) {
    bool isRoundEmpty = (roundTotals[static_cast<size_t>(roundIndex)] == 0);

    if (isRoundEmpty) {
      outReport.weakestDoc.push_back(-1);
      outReport.strongestDoc.push_back(-1);
    } else {
      size_t minRow = denseMatrix.argMinInColumn(static_cast<size_t>(roundIndex));
      size_t maxRow = denseMatrix.argMaxInColumn(static_cast<size_t>(roundIndex));
      outReport.weakestDoc.push_back(static_cast<int>(minRow));
      outReport.strongestDoc.push_back(static_cast<int>(maxRow));
    }
  }

  return true;
}

}  // namespace admitflow
