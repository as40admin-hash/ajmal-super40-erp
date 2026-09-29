AJMAL SUPER 40 ERP - Faculty / Teacher Attendance Report Fix

This update fixes Faculty / Teacher Attendance Report returning 0 records when
attendance has been saved, especially for class-level attendance with blank
Batch_ID and optional Batch filtering.

Implementation:
- Faculty report is now read from the authoritative Faculty_Attendance sheet on
  the Apps Script backend, not from the client bootstrap subset.
- Supports CLASS scope records using Campus_Name + Class_Name + Category_Name.
- Supports BATCH scope records using Batch_ID / Batch_Code.
- All Classes + All Batches works for a selected campus.
- Specific Class + All Batches works.
- Specific Batch returns only batch-attributable records.
- Branch/Campus/Attendance-Operator authorization remains enforced.
- Faculty name/subject/initials fall back to Faculty Master where legacy records
  are missing display fields.

Use Code.gs as the Apps Script backend file. Code.js is intentionally not
included in this package to avoid duplicate-script confusion.

Frontend cache version: 20260929-1630-faculty-report-authoritative
