AJMAL SUPER 40 ERP — Result Display / PDF Update
Date: 26 September 2026

Implemented:
1. JEE results display only Physics, Chemistry and Mathematics; Botany and Zoology are excluded.
2. NEET results display only Physics, Chemistry, Botany and Zoology; Mathematics is excluded.
3. Search Result by UIN now supports selecting one or multiple exams.
4. UIN result display is grouped exam-wise with Subject / Max Marks / Obtained Marks tables.
5. Performance trend graph compares the selected student's percentage against the topper for each selected exam (category-aware, branch/session scoped).
6. Save as PDF now uses A4 Portrait layout with improved typography and exam-wise subject sections.
7. Download as PDF uses a generated PDF Blob for reliable browser download and includes the same subject filtering and trend graph for UIN reports.
8. Result summary display/PDF detail lists include an Applicable Subjects column so irrelevant JEE/NEET subjects never appear.
9. Results schema now supports Botany_Marks, Zoology_Marks, Mathematics_Marks, Total_Obtained_Marks and Total_Max_Marks while retaining legacy fields.
10. Frontend cache-buster updated to scripts.js?v=20260926-1235.

Deployment:
Replace Index.html, scripts.js, Code.gs and worker.js with the files in this package.
Deploy the updated Google Apps Script version before testing Download as PDF.
