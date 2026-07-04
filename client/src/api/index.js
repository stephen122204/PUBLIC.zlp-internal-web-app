import api from './client';

export const getMe = () => api.get('/api/auth/me');
export const logout = () => api.post('/api/auth/logout');
export const validateInvite = (token) => api.get(`/api/auth/validate-invite/${token}`);

// Admin cohorts
export const getCohorts = (includeArchived = false) =>
  api.get(`/api/admin/cohorts${includeArchived ? '?includeArchived=true' : ''}`);
export const createCohort = (data) => api.post('/api/admin/cohorts', data);
export const reorderCohorts = (orderedIds) => api.patch('/api/admin/cohorts/reorder', { orderedIds });
export const getCohort = (id) => api.get(`/api/admin/cohorts/${id}`);
export const updateCohort = (id, data) => api.patch(`/api/admin/cohorts/${id}`, data);
export const archiveCohort = (id) => api.post(`/api/admin/cohorts/${id}/archive`);
export const unarchiveCohort = (id) => api.post(`/api/admin/cohorts/${id}/unarchive`);

// Admin invite links (deprecated — kept for backward compatibility)
export const generateInviteLink = (cohortId) =>
  api.post(`/api/admin/cohorts/${cohortId}/invite-link`);
export const getInviteLinks = (cohortId) =>
  api.get(`/api/admin/cohorts/${cohortId}/invite-link`);
export const revokeInviteLink = (linkId) =>
  api.post(`/api/admin/invite-links/${linkId}/revoke`);
export const regenerateInviteLink = (cohortId) =>
  api.post(`/api/admin/cohorts/${cohortId}/invite-link/regenerate`);

// Admin join codes
export const getJoinCode = (cohortId) =>
  api.get(`/api/admin/cohorts/${cohortId}/join-code`);
export const generateJoinCode = (cohortId) =>
  api.post(`/api/admin/cohorts/${cohortId}/join-code/generate`);
export const regenerateJoinCode = (cohortId) =>
  api.post(`/api/admin/cohorts/${cohortId}/join-code/regenerate`);
export const setCustomJoinCode = (cohortId, code) =>
  api.put(`/api/admin/cohorts/${cohortId}/join-code`, { code });
export const setJoinCodeEnabled = (cohortId, enabled) =>
  api.patch(`/api/admin/cohorts/${cohortId}/join-code/enabled`, { enabled });

// Student — join cohort by code
export const joinCohort = (code) =>
  api.post('/api/student/join-cohort', { code });
export const getCohortStatus = () =>
  api.get('/api/student/cohort-status');

// Admin members
export const getCohortMembers = (cohortId, includeRemoved = false) =>
  api.get(`/api/admin/cohorts/${cohortId}/members${includeRemoved ? '?includeRemoved=true' : ''}`);
export const removeMember = (cohortId, userId) =>
  api.post(`/api/admin/cohorts/${cohortId}/members/${userId}/remove`);

// ---------------------------------------------------------------------------
// Student — course search
// ---------------------------------------------------------------------------
export const searchCourses = ({ q, campus = 'college-station' }) =>
  api.get('/api/student/courses/search', { params: { q, campus } });

export const getCourseCatalogTitle = (code) =>
  api.get('/api/student/courses/catalog-title', { params: { code } });

export const getCourseSubjects = ({ campus = 'college-station' } = {}) =>
  api.get('/api/student/courses/subjects', { params: { campus } });

export const getCoursesBySubject = ({ subject, campus = 'college-station' }) =>
  api.get('/api/student/courses/by-subject', { params: { subject, campus } });

export const getCourseHistory = ({ subject, course, campus = 'college-station' }) =>
  api.get('/api/student/courses/history', { params: { subject, course, campus } });

export const getCourseSections = ({ subject, course, term }) =>
  api.get('/api/student/courses/sections', { params: { subject, course, term } });

// ---------------------------------------------------------------------------
// Student — degree plans
// ---------------------------------------------------------------------------
export const getDegreePlans = () => api.get('/api/student/degree-plans');

export const getDegreePlan = (planId) => api.get(`/api/student/degree-plans/${planId}`);

// ---------------------------------------------------------------------------
// Student — cohort
// ---------------------------------------------------------------------------
export const getStudentCohort = () => api.get('/api/student/cohort');

// ---------------------------------------------------------------------------
// Student — degree plan selection
// ---------------------------------------------------------------------------
export const getDegreePlanSelection = () => api.get('/api/student/degree-plan-selection');
export const saveDegreePlanSelection = (planId) =>
  api.put('/api/student/degree-plan-selection', { planId });

// ---------------------------------------------------------------------------
// Student — course requests
// ---------------------------------------------------------------------------
export const getCourseRequests = () => api.get('/api/student/course-requests');
export const addCourseRequest = (course) => api.post('/api/student/course-requests', course);
export const deleteCourseRequest = (id) => api.delete(`/api/student/course-requests/${id}`);
export const saveSectionPreferences = (courseRequestId, sections) =>
  api.put(`/api/student/course-requests/${courseRequestId}/section-preferences`, { sections });
export const reclassifyMyRequests = () => api.post('/api/student/course-requests/reclassify');

// ---------------------------------------------------------------------------
// Student — submission
// ---------------------------------------------------------------------------
export const getStudentSubmission = () => api.get('/api/student/submission');
export const submitStudentSubmission = () => api.post('/api/student/submission');

// ---------------------------------------------------------------------------
// Admin — submissions
// ---------------------------------------------------------------------------
export const getAdminCohortSubmissions = (cohortId, cycleId) =>
  api.get(`/api/admin/cohorts/${cohortId}/submissions${cycleId ? `?cycleId=${cycleId}` : ''}`);

// ---------------------------------------------------------------------------
// Admin — scheduling cycles
// ---------------------------------------------------------------------------
export const getTermOptions = () => api.get('/api/admin/term-options');
export const getCyclesForCohort = (cohortId, showArchived = false) =>
  api.get(`/api/admin/cohorts/${cohortId}/cycles${showArchived ? '?showArchived=true' : ''}`);
export const createSchedulingCycle = (cohortId, data) => api.post(`/api/admin/cohorts/${cohortId}/cycles`, data);
export const updateSchedulingCycle = (cycleId, data) => api.patch(`/api/admin/cycles/${cycleId}`, data);
export const activateCycle = (cycleId) => api.post(`/api/admin/cycles/${cycleId}/activate`);
export const closeCycle = (cycleId) => api.post(`/api/admin/cycles/${cycleId}/close`);
export const reopenCycle = (cycleId) => api.post(`/api/admin/cycles/${cycleId}/reopen`);
export const deleteSchedulingCycle = (cycleId) => api.delete(`/api/admin/cycles/${cycleId}`);

// ---------------------------------------------------------------------------
// Developer — student preview
// ---------------------------------------------------------------------------
export const getDevCohorts = () => api.get('/api/developer/cohorts');
export const getDevStudents = (cohortId) => api.get(`/api/developer/cohorts/${cohortId}/students`);
export const getDevStudentContext = (studentId, params) =>
  api.get(`/api/developer/students/${studentId}/context`, { params });
export const devUpdateDegreePlan = (studentId, data) =>
  api.patch(`/api/developer/students/${studentId}/degree-plan-selection`, data);
export const devAddCourseRequest = (studentId, data) =>
  api.post(`/api/developer/students/${studentId}/course-requests`, data);
export const devDeleteCourseRequest = (studentId, requestId, data) =>
  api.delete(`/api/developer/students/${studentId}/course-requests/${requestId}`, { data });
export const devSaveSectionPrefs = (studentId, requestId, data) =>
  api.put(`/api/developer/students/${studentId}/course-requests/${requestId}/section-preferences`, data);
export const devSubmit = (studentId, data) =>
  api.post(`/api/developer/students/${studentId}/submission`, data);

// ---------------------------------------------------------------------------
// Developer — dummy students
// ---------------------------------------------------------------------------
export const createDummyStudent = (cohortId, data) =>
  api.post(`/api/developer/cohorts/${cohortId}/dummy-students`, data);
export const getDummyStudents = (cohortId) =>
  api.get(`/api/developer/cohorts/${cohortId}/dummy-students`);
export const removeDummyStudent = (studentId) =>
  api.post(`/api/developer/dummy-students/${studentId}/remove`);
export const updateDummyStudent = (studentId, data) =>
  api.patch(`/api/developer/dummy-students/${studentId}`, data);

// ---------------------------------------------------------------------------
// Admin — student review
// ---------------------------------------------------------------------------
export const getAdminStudentSubmission = (studentId, params) =>
  api.get(`/api/admin/students/${studentId}/submission`, { params });
export const adminAddStudentCourseRequest = (studentId, data) =>
  api.post(`/api/admin/students/${studentId}/course-requests`, data);
export const adminDeleteStudentCourseRequest = (studentId, requestId, params) =>
  api.delete(`/api/admin/students/${studentId}/course-requests/${requestId}`, { params });
export const adminSaveStudentSectionPreferences = (studentId, requestId, data) =>
  api.put(`/api/admin/students/${studentId}/course-requests/${requestId}/section-preferences`, data);
export const adminGetCourseSections = (subject, course, termCode) =>
  api.get('/api/admin/courses/sections', { params: { subject, course, termCode } });
export const adminUpdateCourseClassification = (studentId, requestId, data) =>
  api.patch(`/api/admin/students/${studentId}/course-requests/${requestId}/classification`, data);
export const adminReclassifyStudent = (studentId, data) =>
  api.post(`/api/admin/students/${studentId}/reclassify`, data);
export const adminReclassifyCohortCycle = (cohortId, cycleId) =>
  api.post(`/api/admin/cohorts/${cohortId}/cycles/${cycleId}/reclassify`);
export const adminUpdateStudentSubmissionStatus = (studentId, data) =>
  api.post(`/api/admin/students/${studentId}/submission`, data);

// ---------------------------------------------------------------------------
// Academic Programs (majors + minors list — available to all logged-in users)
// ---------------------------------------------------------------------------
export const getAcademicPrograms = (params) => api.get('/api/academic-programs', { params });
export const getAcademicMajors = (params) => api.get('/api/academic-programs/majors', { params });
export const getAcademicMinors = (params) => api.get('/api/academic-programs/minors', { params });
export const getAcademicProgram = (id) => api.get(`/api/academic-programs/${encodeURIComponent(id)}`);

// ---------------------------------------------------------------------------
// Admin — academic profile
// ---------------------------------------------------------------------------
export const getAdminStudentAcademicProfile = (studentId, cohortId) =>
  api.get(`/api/admin/students/${studentId}/academic-profile`, { params: { cohortId } });
export const saveAdminStudentAcademicProfile = (studentId, data) =>
  api.put(`/api/admin/students/${studentId}/academic-profile`, data);

// ---------------------------------------------------------------------------
// Student — academic profile
// ---------------------------------------------------------------------------
export const getStudentAcademicProfile = () => api.get('/api/student/academic-profile');
export const saveStudentAcademicProfile = (data) => api.put('/api/student/academic-profile', data);

// ---------------------------------------------------------------------------
// Student — semester plan / degree planner
// ---------------------------------------------------------------------------
export const getStudentTermOptions = () => api.get('/api/student/degree-plan/term-options');
export const getStudentSemesterPlan = () => api.get('/api/student/degree-plan/semesters');
export const saveStudentSemesterPlan = (semesters) => api.put('/api/student/degree-plan/semesters', { semesters });
export const importDegreePlanText = (text) => api.post('/api/student/degree-plan/import-text', { text });
export const importDegreePlanScreenshot = (formData) => api.post('/api/student/degree-plan/import-screenshot', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
export const confirmDegreePlanImport = (semesters, mergeMode = 'replace') => api.post('/api/student/degree-plan/confirm-import', { semesters, mergeMode });

// ---------------------------------------------------------------------------
// Degree requirement graph
// ---------------------------------------------------------------------------
export const getDegreeGraph = (programId) => api.get(`/api/degree-graph/${encodeURIComponent(programId)}`);
export const refreshDegreeGraph = (programId) => api.post(`/api/degree-graph/developer/${encodeURIComponent(programId)}/refresh`);
export const buildEngineeringGraphs = () => api.post('/api/degree-graph/developer/build-engineering');

// ---------------------------------------------------------------------------
// Admin — student degree plan
// ---------------------------------------------------------------------------
export const getAdminStudentDegreePlan = (studentId, cohortId) =>
  api.get(`/api/admin/students/${studentId}/degree-plan`, { params: { cohortId } });
export const saveAdminStudentDegreePlan = (studentId, cohortId, semesters) =>
  api.put(`/api/admin/students/${studentId}/degree-plan`, { cohortId, semesters });

// ---------------------------------------------------------------------------
// Admin — ZLP algorithm
// ---------------------------------------------------------------------------
export const runAlgorithm = (data) => api.post('/api/admin/algorithm/run', data);
export const getAlgorithmRuns = (params) => api.get('/api/admin/algorithm/runs', { params });
export const getAlgorithmRun = (runId) => api.get(`/api/admin/algorithm/runs/${runId}`);
// Download returns a blob — caller must set responseType: 'blob'
export const downloadAlgorithmRunUrl = (runId) => `/api/admin/algorithm/runs/${runId}/download`;
export const getAlgorithmDebugInput = (cohortId, schedulingCycleId) =>
  api.get('/api/admin/algorithm/debug-input', { params: { cohortId, schedulingCycleId } });
export const getWindowCountDebug = (runId, day, startMinutes) =>
  api.post('/api/admin/algorithm/window-count-debug', { runId, day, startMinutes });

// ---------------------------------------------------------------------------
// Admin — demo student
// ---------------------------------------------------------------------------
export const getDemoStudent = () => api.get('/api/admin/demo-student');
export const startDemoSession = () => api.post('/api/admin/demo-student/session/start');
export const resetDemoStudent = () => api.post('/api/admin/demo-student/reset');
