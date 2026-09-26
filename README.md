AJMAL SUPER 40 ERP — Result Display / PDF Update
Date: 26 September 2026

Implemented:
1. JEE results display only Physics, Chemistry and Mathematics; Botany and Zoology are excluded.
2. NEET results display only Physics, Chemistry, Botany and Zoology; Mathematics is excluded.
3. Search Result by UIN supports selecting one or multiple exams.
4. UIN result display is grouped by stream and shows one row per exam with applicable subject marks as Obtained / Max, plus Total, Percentage and Rank.
5. Student Details now explicitly display UIN, Student Name, Father's Name, Category, Class and Batch (when available).
6. Performance trend graph compares the selected student's percentage against the Class Topper for the entire ERP database for each selected exam. Topper grouping is Exam + Category + Class, across all branches/campuses/batches; it is NOT restricted by the viewing user's branch/session scope.
7. Save as PDF uses A4 Portrait layout with improved typography. Student Details and the trend graph remain inside the left half of the page.
8. PDF exam results are full-width and center aligned, with one row per exam and only the applicable subject columns for JEE/NEET.
9. Student details are not repeated in the PDF result tables. Category, Class and Batch appear only in the Student Details block for individual UIN reports.
10. The institute logo is displayed once at the top of the PDF instead of the textual institute name. The logo is not repeated in the body or footer.
11. Download as PDF uses the generated PDF Blob for reliable browser download and follows the same subject filtering, portrait layout and trend graph rules.
12. Result summary display/PDF detail lists include Category and Applicable Subjects so irrelevant JEE/NEET subjects never appear.
13. Results schema supports Botany_Marks, Zoology_Marks, Mathematics_Marks, Total_Obtained_Marks and Total_Max_Marks while retaining legacy fields.
14. Entire-ERP Class Topper benchmark: topper is selected by highest valid percentage within the same Exam + Category + Class. Ties are resolved by higher total obtained marks.
15. Frontend cache-buster updated to scripts.js?v=20260926-1805.

Deployment:
Replace Index.html, scripts.js, Code.gs and worker.js with the files in this package.
Deploy the updated Google Apps Script version before testing Download as PDF.
