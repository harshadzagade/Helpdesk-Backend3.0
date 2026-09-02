// controller/dashboardController.js ✅ FULL UPDATED (Superadmin + Admin/Subadmin + Engineer + User)
// Features:
// ✅ Superadmin: deptId filter + type filter (all/complaint/request) + departmentSummary sortable
// ✅ Admin/Subadmin: activeDepartment-based + approvalPending + unassigned + lists + engineer workload + activities + SLA
// ✅ Engineer: assigned stats + SLA + recent tickets
// ✅ User: my tickets stats + recent tickets
// ✅ Date range: ?from=YYYY-MM-DD&to=YYYY-MM-DD (default last 7 days)
// ✅ Mixed counts from Complaint + Request

const { Op } = require("sequelize");
const Complaint = require("../models/complaint");
const Request = require("../models/request");
const Staff = require("../models/staff");
const Department = require("../models/department");
const SubadminActivity = require("../models/subadminActivity");
const ReminderLog = require("../models/reminderLog");
const { getReminderSchedulerStatus, runReminderJob, updateReminderSettings } = require("../utils/reminderJob");
const { emitTicketReminderRefresh } = require("../utils/realtime");
const { rephraseSentence } = require("../utils/textRephrase");
const { buildTicketSubject, renderEmailLayout, sendMail } = require("../utils/mailer");

/* ========================= HELPERS ========================= */

const toInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
};

const roleLower = (s) => String(s?.role || "").toLowerCase();

const deptIdsOf = (staff) =>
    Array.isArray(staff?.departmentIds) ? staff.departmentIds : [];

const normalizeType = (t) =>
    String(t || "all").toLowerCase().trim(); // all | complaint | request

const normalizeStatusKey = (s) => String(s || "").toLowerCase().trim();
const isClosedStatus = (status) => normalizeStatusKey(status) === "closed";

const buildDateWhere = (from, to) => ({
    createdAt: { [Op.between]: [from, to] },
});

const parseDateRange = (req) => {
    const fromQ = req.query.from ? new Date(req.query.from) : null;
    const toQ = req.query.to ? new Date(req.query.to) : null;

    const to = toQ && !isNaN(toQ) ? toQ : new Date();
    const from =
        fromQ && !isNaN(fromQ)
            ? fromQ
            : (() => {
                const d = new Date(to);
                d.setDate(d.getDate() - 6);
                d.setHours(0, 0, 0, 0);
                return d;
            })();

    const toEnd = new Date(to);
    toEnd.setHours(23, 59, 59, 999);

    return { from, to: toEnd };
};

const getCurrentStaff = async (req) => {
    const staffId = req.user?.id;
    if (!staffId) {
        const err = new Error("Unauthorized");
        err.statusCode = 401;
        throw err;
    }

    const staff = await Staff.findByPk(staffId);
    if (!staff) {
        const err = new Error("Staff not found");
        err.statusCode = 404;
        throw err;
    }

    return staff;
};

const ensureActiveDeptAllowed = (staff, req) => {
    const activeDeptId = toInt(req.departmentId); // middleware activeDepartment se
    if (!activeDeptId) {
        const err = new Error("Active department missing (x-department-id required)");
        err.statusCode = 400;
        throw err;
    }

    // superadmin bypass
    if (roleLower(staff) === "superadmin") return activeDeptId;

    const ids = deptIdsOf(staff).map(Number);
    if (!ids.includes(Number(activeDeptId))) {
        const err = new Error("Not allowed for this department (switch active department)");
        err.statusCode = 403;
        throw err;
    }
    return activeDeptId;
};

/* ========================= MIXED UTILITIES ========================= */

async function countMix(whereC = {}, whereR = {}) {
    const [c, r] = await Promise.all([
        Complaint.count({ where: whereC }),
        Request.count({ where: whereR }),
    ]);
    return c + r;
}

async function countsByStatus(whereBaseC = {}, whereBaseR = {}) {
    const wPendingC = { ...whereBaseC, status: { [Op.iLike]: "pending" } };
    const wPendingR = { ...whereBaseR, status: { [Op.iLike]: "pending" } };

    const wInC = {
        ...whereBaseC,
        status: {
            [Op.or]: [{ [Op.iLike]: "in progress" }, { [Op.iLike]: "in-progress" }],
        },
    };
    const wInR = {
        ...whereBaseR,
        status: {
            [Op.or]: [{ [Op.iLike]: "in progress" }, { [Op.iLike]: "in-progress" }],
        },
    };

    const wClosedC = { ...whereBaseC, status: { [Op.iLike]: "closed" } };
    const wClosedR = { ...whereBaseR, status: { [Op.iLike]: "closed" } };

    const [total, pending, inProgress, closed] = await Promise.all([
        countMix(whereBaseC, whereBaseR),
        countMix(wPendingC, wPendingR),
        countMix(wInC, wInR),
        countMix(wClosedC, wClosedR),
    ]);

    return { total, pending, inProgress, closed };
}

async function prioritySplit(whereBaseC = {}, whereBaseR = {}) {
    const priorities = ["high", "medium", "low"];

    const makeCount = (Model, whereBase, p) =>
        Model.count({
            where: {
                ...whereBase,
                priority: { [Op.iLike]: p },
            },
        });

    const out = { high: 0, medium: 0, low: 0 };

    for (const p of priorities) {
        const [c, r] = await Promise.all([
            makeCount(Complaint, whereBaseC, p),
            makeCount(Request, whereBaseR, p),
        ]);
        out[p] = c + r;
    }

    return out;
}

async function slaBreaches(whereBaseC = {}, whereBaseR = {}) {
    // SLA rules (edit as needed)
    // Pending > 24h, InProgress > 48h
    const now = new Date();
    const pendingCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const inProgCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const pendingWhereC = {
        ...whereBaseC,
        status: { [Op.iLike]: "pending" },
        createdAt: { [Op.lte]: pendingCutoff },
    };
    const pendingWhereR = {
        ...whereBaseR,
        status: { [Op.iLike]: "pending" },
        createdAt: { [Op.lte]: pendingCutoff },
    };

    const inWhereC = {
        ...whereBaseC,
        status: {
            [Op.or]: [{ [Op.iLike]: "in progress" }, { [Op.iLike]: "in-progress" }],
        },
        createdAt: { [Op.lte]: inProgCutoff },
    };
    const inWhereR = {
        ...whereBaseR,
        status: {
            [Op.or]: [{ [Op.iLike]: "in progress" }, { [Op.iLike]: "in-progress" }],
        },
        createdAt: { [Op.lte]: inProgCutoff },
    };

    const [pendingBreach, inProgressBreach] = await Promise.all([
        countMix(pendingWhereC, pendingWhereR),
        countMix(inWhereC, inWhereR),
    ]);

    return {
        pendingBreach,
        inProgressBreach,
        totalBreached: pendingBreach + inProgressBreach,
    };
}

async function recentTickets(whereBaseC = {}, whereBaseR = {}, limit = 10) {
    const [cList, rList] = await Promise.all([
        Complaint.findAll({
            where: whereBaseC,
            order: [["createdAt", "DESC"]],
            limit,
            attributes: [
                "id",
                "ticketId",
                "subject",
                "status",
                "priority",
                "departmentId",
                "createdAt",
                "assignStaffId",
                "staffId",
            ],
        }),
        Request.findAll({
            where: whereBaseR,
            order: [["createdAt", "DESC"]],
            limit,
            attributes: [
                "id",
                "ticketId",
                "subject",
                "status",
                "priority",
                "departmentId",
                "createdAt",
                "assignStaffId",
                "staffId",
            ],
        }),
    ]);

    const mix = [
        ...cList.map((x) => ({ ...x.toJSON(), type: "Complaint" })),
        ...rList.map((x) => ({ ...x.toJSON(), type: "Request" })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return mix.slice(0, limit);
}

const reminderTicketPayload = (row, type, reason) => ({
    id: row.id,
    ticketId: row.ticketId,
    type,
    reason,
    subject: row.subject || "No subject",
    status: row.status || "N/A",
    priority: row.priority || "N/A",
    createdAt: row.createdAt,
    path: type === "Complaint" ? `/complaints/${row.id}` : `/requests/${row.id}`,
});

async function trendLastDays(whereBaseC = {}, whereBaseR = {}, days = 7) {
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);

    const [c, r] = await Promise.all([
        Complaint.findAll({
            where: { ...whereBaseC, createdAt: { [Op.between]: [start, end] } },
            attributes: ["createdAt", "status"],
        }),
        Request.findAll({
            where: { ...whereBaseR, createdAt: { [Op.between]: [start, end] } },
            attributes: ["createdAt", "status"],
        }),
    ]);

    const fmt = (d) => {
        const x = new Date(d);
        const yyyy = x.getFullYear();
        const mm = String(x.getMonth() + 1).padStart(2, "0");
        const dd = String(x.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
    };

    const map = new Map();
    for (let i = 0; i < days; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        map.set(fmt(d), { date: fmt(d), created: 0, closed: 0 });
    }

    const add = (row) => {
        const key = fmt(row.createdAt);
        if (!map.has(key)) return;
        const obj = map.get(key);
        obj.created += 1;
        if (normalizeStatusKey(row.status) === "closed") obj.closed += 1;
        map.set(key, obj);
    };

    c.forEach(add);
    r.forEach(add);

    return Array.from(map.values());
}

/* ========================= SUPERADMIN SUMMARY ========================= */
/**
 * GET /api/dashboard/superadmin?from=&to=&deptId=&type=
 * type: all | complaint | request
 */
exports.superadminSummary = async (req, res) => {
    try {
        const staff = await getCurrentStaff(req);
        if (roleLower(staff) !== "superadmin") {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const deptId = toInt(req.query.deptId); // optional
        const type = normalizeType(req.query.type); // all/complaint/request
        const { from, to } = parseDateRange(req);

        const whereDept = deptId ? { departmentId: deptId } : {};
        const whereRange = buildDateWhere(from, to);

        const whereC = { ...whereDept, ...whereRange };
        const whereR = { ...whereDept, ...whereRange };

        const useComplaints = type === "all" || type === "complaint";
        const useRequests = type === "all" || type === "request";

        const safeWhereC = useComplaints ? whereC : { id: -999999 };
        const safeWhereR = useRequests ? whereR : { id: -999999 };

        const [counts, pr, sla, trend, recent] = await Promise.all([
            countsByStatus(safeWhereC, safeWhereR),
            prioritySplit(safeWhereC, safeWhereR),
            slaBreaches(safeWhereC, safeWhereR),
            trendLastDays(
                useComplaints ? whereDept : { id: -999999 },
                useRequests ? whereDept : { id: -999999 },
                7
            ),
            recentTickets(safeWhereC, safeWhereR, 10),
        ]);

        // today tickets
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const todayWhereC = { ...whereDept, createdAt: { [Op.gte]: todayStart } };
        const todayWhereR = { ...whereDept, createdAt: { [Op.gte]: todayStart } };

        const todayTickets = await countMix(
            useComplaints ? todayWhereC : { id: -999999 },
            useRequests ? todayWhereR : { id: -999999 }
        );

        // ✅ Department summary for table sorting
        const allDepartments = await Department.findAll({
            attributes: ["id", "department", "type"],
            order: [["department", "ASC"]],
        });

        const departmentSummary = await Promise.all(
            (allDepartments || []).map(async (d) => {
                const depFilter = { departmentId: d.id, ...whereRange };

                const complaints = useComplaints
                    ? await Complaint.count({ where: depFilter })
                    : 0;

                const requests = useRequests
                    ? await Request.count({ where: depFilter })
                    : 0;

                return {
                    id: d.id,
                    department: d.department,
                    type: d.type,
                    total: complaints + requests,
                    complaints,
                    requests,
                };
            })
        );

        return res.json({
            success: true,
            data: {
                range: { from, to },
                filters: { deptId: deptId || null, type },
                ...counts,
                todayTickets,
                priority: pr,
                sla,
                trend,
                recentTickets: recent,
                departmentSummary,
            },
        });
    } catch (e) {
        return res.status(e.statusCode || 500).json({
            success: false,
            message: e.message || "Error",
        });
    }
};

/* ========================= ADMIN / SUBADMIN SUMMARY ========================= */
/**
 * GET /api/dashboard/admin?from=&to=
 * Requires activeDepartment middleware -> req.departmentId
 */
// controller/dashboardController.js
// ✅ REPLACE ONLY exports.adminSummary with this updated version
exports.adminSummary = async (req, res) => {
    try {
      const staff = await getCurrentStaff(req);
      const role = roleLower(staff);
  
      if (!["admin", "subadmin"].includes(role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
  
      const activeDeptId = ensureActiveDeptAllowed(staff, req);
  
      const { from, to } = parseDateRange(req);
      const whereRange = buildDateWhere(from, to);
  
      // ✅ dept scoped for KPI (complaint + request of active dept)
      const whereDept = { departmentId: activeDeptId };
      const whereC = { ...whereDept, ...whereRange };
      const whereR = { ...whereDept, ...whereRange };
  
      const [counts, pr, sla, recent] = await Promise.all([
        countsByStatus(whereC, whereR),
        prioritySplit(whereC, whereR),
        slaBreaches(whereC, whereR),
        recentTickets(whereC, whereR, 10),
      ]);
  
      /* ===================== ✅ SINGLE APPROVAL PENDING ===================== */
      const staffDeptIds = deptIdsOf(staff).map(Number);
  
      // 1) Pending (HOD1 type approvals): status=pending (range only)
      const pendingRequests = await Request.findAll({
        where: { ...whereRange, status: { [Op.iLike]: "pending" } },
        order: [["createdAt", "DESC"]],
        limit: 30, // fetch more then filter
        attributes: ["id", "ticketId", "subject", "status", "priority", "createdAt", "staffId", "departmentId"],
      });
  
      // filter pending by requester dept common
      const approvalPendingList = [];
  
      for (const reqItem of pendingRequests) {
        const requester = await Staff.findByPk(reqItem.staffId, {
          attributes: ["id", "departmentIds", "firstname", "middlename", "lastname", "email"],
        });
        if (!requester) continue;
  
        const requesterDeptIds = deptIdsOf(requester).map(Number);
        const hasCommon = requesterDeptIds.some((d) => staffDeptIds.includes(d));
  
        if (hasCommon) {
          approvalPendingList.push({
            ...reqItem.toJSON(),
            type: "Request",
          });
        }
  
        if (approvalPendingList.length >= 10) break;
      }
  
      // 2) HOD2 pending (hod1-approved) in active dept
      const hod2Queue = await Request.findAll({
        where: {
          ...whereRange,
          departmentId: activeDeptId,
          status: { [Op.iLike]: "hod1-approved" },
        },
        order: [["createdAt", "DESC"]],
        limit: 10,
        attributes: ["id", "ticketId", "subject", "status", "priority", "createdAt", "staffId", "departmentId"],
      });
  
      // merge (avoid duplicates)
      const seen = new Set(approvalPendingList.map((x) => x.id));
      for (const item of hod2Queue) {
        if (!seen.has(item.id)) {
          approvalPendingList.push({ ...item.toJSON(), type: "Request" });
        }
        if (approvalPendingList.length >= 10) break;
      }
  
      // ✅ count (approx - list size). If you want exact count, tell me and I’ll optimize.
      const approvalPendingCount = approvalPendingList.length;
  
      /* ===================== UNASSIGNED (Active Dept) ===================== */
      const [unassignedComplaints, unassignedRequests] = await Promise.all([
        Complaint.count({ where: { ...whereC, assignStaffId: { [Op.is]: null } } }),
        Request.count({ where: { ...whereR, assignStaffId: { [Op.is]: null } } }),
      ]);
  
      const [unassignedComplaintsList, unassignedRequestsList] = await Promise.all([
        Complaint.findAll({
          where: { ...whereC, assignStaffId: { [Op.is]: null } },
          order: [["createdAt", "DESC"]],
          limit: 10,
          attributes: ["id", "ticketId", "subject", "status", "priority", "createdAt", "staffId", "departmentId"],
        }),
        Request.findAll({
          where: { ...whereR, assignStaffId: { [Op.is]: null } },
          order: [["createdAt", "DESC"]],
          limit: 10,
          attributes: ["id", "ticketId", "subject", "status", "priority", "createdAt", "staffId", "departmentId"],
        }),
      ]);
  
      const unassignedList = [
        ...unassignedComplaintsList.map((x) => ({ ...x.toJSON(), type: "Complaint" })),
        ...unassignedRequestsList.map((x) => ({ ...x.toJSON(), type: "Request" })),
      ]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10);
  
      /* ===================== ENGINEER WORKLOAD (Active Dept) ===================== */
      const engineers = await Staff.findAll({
        where: {
          departmentIds: { [Op.contains]: [activeDeptId] },
          role: { [Op.in]: ["engineer", "engineers"] },
        },
        attributes: ["id", "firstname", "middlename", "lastname", "email"],
      });
  
      const engineerLoad = await Promise.all(
        (engineers || []).map(async (eng) => {
          const name =
            `${eng.firstname || ""} ${eng.middlename || ""} ${eng.lastname || ""}`
              .replace(/\s+/g, " ")
              .trim() || eng.email || String(eng.id);
  
          const baseAssigned = { assignStaffId: eng.id, departmentId: activeDeptId, ...whereRange };
  
          const [assignedTotal, pending, inProgress, closed] = await Promise.all([
            countMix(baseAssigned, baseAssigned),
            countMix(
              { ...baseAssigned, status: { [Op.iLike]: "pending" } },
              { ...baseAssigned, status: { [Op.iLike]: "pending" } }
            ),
            countMix(
              { ...baseAssigned, status: { [Op.or]: [{ [Op.iLike]: "in progress" }, { [Op.iLike]: "in-progress" }] } },
              { ...baseAssigned, status: { [Op.or]: [{ [Op.iLike]: "in progress" }, { [Op.iLike]: "in-progress" }] } }
            ),
            countMix(
              { ...baseAssigned, status: { [Op.iLike]: "closed" } },
              { ...baseAssigned, status: { [Op.iLike]: "closed" } }
            ),
          ]);
  
          return { id: eng.id, name, assignedTotal, pending, inProgress, closed };
        })
      );
  
      /* ===================== ACTIVITY FEED (Dept) ===================== */
      const activities = await SubadminActivity.findAll({
        where: { departmentId: activeDeptId },
        order: [["createdAt", "DESC"]],
        limit: 10,
        attributes: ["id", "subadminId", "departmentId", "actionTaken", "createdAt"],
      });
  
      return res.json({
        success: true,
        data: {
          range: { from, to },
          ...counts,
  
          // ✅ single approval
          approvalPendingCount,
          approvalPendingList,
  
          // unassigned
          unassigned: unassignedComplaints + unassignedRequests,
          unassignedList,
  
          priority: pr,
          sla,
          recentTickets: recent,
          engineerLoad,
          activities,
        },
      });
    } catch (e) {
      return res.status(e.statusCode || 500).json({
        success: false,
        message: e.message || "Error",
      });
    }
  };
  
  exports.engineerSummary = async (req, res) => {
    try {
      const staff = await getCurrentStaff(req);
      const role = roleLower(staff);
  
      if (!["engineer", "engineers"].includes(role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
  
      const { from, to } = parseDateRange(req);
      const whereRange = buildDateWhere(from, to);
  
      const whereAssignedC = { assignStaffId: staff.id, ...whereRange };
      const whereAssignedR = { assignStaffId: staff.id, ...whereRange };
  
      const [counts, pr, sla, recent] = await Promise.all([
        countsByStatus(whereAssignedC, whereAssignedR),
        prioritySplit(whereAssignedC, whereAssignedR),
        slaBreaches(whereAssignedC, whereAssignedR),
        recentTickets(whereAssignedC, whereAssignedR, 10),
      ]);
  
      return res.json({
        success: true,
        data: {
          range: { from, to },
          ...counts,
          priority: pr,
          sla,
          recentTickets: recent,
        },
      });
    } catch (e) {
      return res.status(e.statusCode || 500).json({
        success: false,
        message: e.message || "Error",
      });
    }
  };
  
  // ✅ Engineer assigned list with filters
  // GET /api/dashboard/engineer/tickets?type=all|complaint|request&status=pending|in-progress|closed
  exports.engineerAssignedTickets = async (req, res) => {
    try {
      const staff = await getCurrentStaff(req);
      const role = roleLower(staff);
  
      if (!["engineer", "engineers"].includes(role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
  
      const type = normalizeType(req.query.type); // all/complaint/request
      const status = (req.query.status || "").toLowerCase().trim();
  
      const { from, to } = parseDateRange(req);
      const whereRange = buildDateWhere(from, to);
  
      const statusWhere = status
        ? {
            status: {
              [Op.or]: [
                { [Op.iLike]: status },
                // allow "in progress" vs "in-progress"
                ...(status === "in-progress"
                  ? [{ [Op.iLike]: "in progress" }]
                  : status === "in progress"
                  ? [{ [Op.iLike]: "in-progress" }]
                  : []),
              ],
            },
          }
        : {};
  
      const whereC = { assignStaffId: staff.id, ...whereRange, ...statusWhere };
      const whereR = { assignStaffId: staff.id, ...whereRange, ...statusWhere };
  
      const useComplaints = type === "all" || type === "complaint";
      const useRequests = type === "all" || type === "request";
  
      const [cList, rList] = await Promise.all([
        useComplaints
          ? Complaint.findAll({
              where: whereC,
              order: [["createdAt", "DESC"]],
              limit: 50,
              attributes: [
                "id",
                "ticketId",
                "subject",
                "status",
                "priority",
                "departmentId",
                "createdAt",
                "staffId",
                "assignStaffId",
              ],
            })
          : Promise.resolve([]),
        useRequests
          ? Request.findAll({
              where: whereR,
              order: [["createdAt", "DESC"]],
              limit: 50,
              attributes: [
                "id",
                "ticketId",
                "subject",
                "status",
                "priority",
                "departmentId",
                "createdAt",
                "staffId",
                "assignStaffId",
              ],
            })
          : Promise.resolve([]),
      ]);
  
      const tickets = [
        ...cList.map((x) => ({ ...x.toJSON(), type: "Complaint" })),
        ...rList.map((x) => ({ ...x.toJSON(), type: "Request" })),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
      return res.json({
        success: true,
        count: tickets.length,
        data: tickets,
      });
    } catch (e) {
      return res.status(e.statusCode || 500).json({
        success: false,
        message: e.message || "Error",
      });
    }
  };

/* ========================= USER SUMMARY ========================= */
/**
 * GET /api/dashboard/user?from=&to=
 */
exports.userSummary = async (req, res) => {
    try {
        const staff = await getCurrentStaff(req);
        const { from, to } = parseDateRange(req);
        const whereRange = buildDateWhere(from, to);

        const whereMineC = { staffId: staff.id, ...whereRange };
        const whereMineR = { staffId: staff.id, ...whereRange };

        const [counts, recent] = await Promise.all([
            countsByStatus(whereMineC, whereMineR),
            recentTickets(whereMineC, whereMineR, 10),
        ]);

        return res.json({
            success: true,
            data: {
                range: { from, to },
                ...counts,
                recentTickets: recent,
            },
        });
    } catch (e) {
        return res.status(e.statusCode || 500).json({
            success: false,
            message: e.message || "Error",
        });
    }
};

exports.ticketReminderPopup = async (req, res) => {
    try {
        const staff = await getCurrentStaff(req);
        const role = roleLower(staff);
        const limit = Math.min(toInt(req.query.limit) || 10, 30);

        if (["admin", "subadmin"].includes(role)) {
            const staffDeptIds = deptIdsOf(staff).map(Number);
            const activeDeptId = toInt(req.headers["x-department-id"]);
            const scopedDeptIds = activeDeptId ? [activeDeptId] : staffDeptIds;
            const items = [];

            const hod1Queue = await Request.findAll({
                where: {
                    hod1Approval: false,
                    status: { [Op.notIn]: ["closed", "Closed", "rejected", "Rejected"] },
                },
                order: [["createdAt", "DESC"]],
                limit: 50,
                attributes: ["id", "ticketId", "subject", "status", "priority", "createdAt", "staffId", "departmentId"],
            });

            for (const item of hod1Queue) {
                const requester = await Staff.findByPk(item.staffId, {
                    attributes: ["id", "departmentIds"],
                });
                const requesterDeptIds = deptIdsOf(requester).map(Number);
                if (requesterDeptIds.some((deptId) => scopedDeptIds.includes(deptId))) {
                    items.push(reminderTicketPayload(item, "Request", "Pending HOD 1 approval"));
                }
                if (items.length >= limit) break;
            }

            if (items.length < limit) {
                const hod2Queue = await Request.findAll({
                    where: {
                        hod1Approval: true,
                        hod2Approval: false,
                        departmentId: { [Op.in]: scopedDeptIds.length ? scopedDeptIds : [-1] },
                        status: { [Op.notIn]: ["closed", "Closed", "rejected", "Rejected"] },
                    },
                    order: [["createdAt", "DESC"]],
                    limit,
                    attributes: ["id", "ticketId", "subject", "status", "priority", "createdAt", "staffId", "departmentId"],
                });

                hod2Queue.forEach((item) => {
                    if (items.length < limit && !items.some((existing) => existing.id === item.id)) {
                        items.push(reminderTicketPayload(item, "Request", "Pending HOD 2 approval"));
                    }
                });
            }

            return res.json({
                success: true,
                data: {
                    title: "Pending Approvals",
                    count: items.length,
                    items,
                },
            });
        }

        if (["engineer", "engineers"].includes(role)) {
            const [complaints, requests] = await Promise.all([
                Complaint.findAll({
                    where: {
                        assignStaffId: staff.id,
                        resolvedAt: { [Op.is]: null },
                        status: { [Op.notIn]: ["closed", "Closed", "rejected", "Rejected"] },
                    },
                    order: [["createdAt", "DESC"]],
                    limit,
                    attributes: ["id", "ticketId", "subject", "status", "priority", "createdAt"],
                }),
                Request.findAll({
                    where: {
                        assignStaffId: staff.id,
                        resolvedAt: { [Op.is]: null },
                        status: { [Op.notIn]: ["closed", "Closed", "rejected", "Rejected"] },
                    },
                    order: [["createdAt", "DESC"]],
                    limit,
                    attributes: ["id", "ticketId", "subject", "status", "priority", "createdAt"],
                }),
            ]);

            const items = [
                ...complaints.map((item) => reminderTicketPayload(item, "Complaint", "Pending to attend / close")),
                ...requests.map((item) => reminderTicketPayload(item, "Request", "Pending to attend / close")),
            ]
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                .slice(0, limit);

            return res.json({
                success: true,
                data: {
                    title: "Assigned Tickets",
                    count: items.length,
                    items,
                },
            });
        }

        if (role === "user") {
            const [complaints, requests] = await Promise.all([
                Complaint.findAll({
                    where: { staffId: staff.id, status: { [Op.iLike]: "closed" } },
                    order: [["updatedAt", "DESC"]],
                    limit,
                    attributes: ["id", "ticketId", "subject", "status", "priority", "createdAt", "updatedAt"],
                }),
                Request.findAll({
                    where: { staffId: staff.id, status: { [Op.iLike]: "closed" } },
                    order: [["updatedAt", "DESC"]],
                    limit,
                    attributes: ["id", "ticketId", "subject", "status", "priority", "createdAt", "updatedAt"],
                }),
            ]);

            const items = [
                ...complaints.map((item) => reminderTicketPayload(item, "Complaint", "Ticket has been closed")),
                ...requests.map((item) => reminderTicketPayload(item, "Request", "Ticket has been closed")),
            ]
                .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
                .slice(0, limit);

            return res.json({
                success: true,
                data: {
                    title: "Closed Tickets",
                    count: items.length,
                    items,
                },
            });
        }

        return res.json({
            success: true,
            data: {
                title: "Ticket Reminders",
                count: 0,
                items: [],
            },
        });
    } catch (e) {
        return res.status(e.statusCode || 500).json({
            success: false,
            message: e.message || "Failed to load ticket reminders",
        });
    }
};

exports.runReminderCheck = async (req, res) => {
    try {
        const staff = await getCurrentStaff(req);
        if (roleLower(staff) !== "superadmin") {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const summary = await runReminderJob();
        emitTicketReminderRefresh({
            roles: ["admin", "subadmin", "engineer", "user"],
            reason: "reminder-job-run",
        });
        return res.json({ success: true, data: summary });
    } catch (e) {
        return res.status(e.statusCode || 500).json({
            success: false,
            message: e.message || "Failed to run reminder check",
        });
    }
};

exports.getReminderStatus = async (req, res) => {
    try {
        const staff = await getCurrentStaff(req);
        if (roleLower(staff) !== "superadmin") {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        return res.json({ success: true, data: await getReminderSchedulerStatus() });
    } catch (e) {
        return res.status(e.statusCode || 500).json({
            success: false,
            message: e.message || "Failed to load reminder scheduler status",
        });
    }
};

exports.updateReminderStatus = async (req, res) => {
    try {
        const staff = await getCurrentStaff(req);
        if (roleLower(staff) !== "superadmin") {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const settings = await updateReminderSettings({
            enabled: req.body.enabled,
            runTime: req.body.runTime,
            thresholdDays: req.body.thresholdDays,
        });

        return res.json({
            success: true,
            data: {
                ...(await getReminderSchedulerStatus()),
                ...settings,
            },
        });
    } catch (e) {
        return res.status(e.statusCode || 500).json({
            success: false,
            message: e.message || "Failed to update reminder scheduler settings",
        });
    }
};

exports.getReminderLogs = async (req, res) => {
    try {
        const staff = await getCurrentStaff(req);
        if (roleLower(staff) !== "superadmin") {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const limit = Math.min(toInt(req.query.limit) || 50, 200);
        const where = {};

        if (req.query.status) {
            where.status = String(req.query.status).trim();
        }
        if (req.query.ticketType) {
            where.ticketType = String(req.query.ticketType).trim().toLowerCase();
        }
        if (req.query.from || req.query.to) {
            const from = req.query.from ? new Date(req.query.from) : null;
            const to = req.query.to ? new Date(req.query.to) : null;
            where.createdAt = {};
            if (from && !Number.isNaN(from.getTime())) {
                from.setHours(0, 0, 0, 0);
                where.createdAt[Op.gte] = from;
            }
            if (to && !Number.isNaN(to.getTime())) {
                to.setHours(23, 59, 59, 999);
                where.createdAt[Op.lte] = to;
            }
            if (Object.keys(where.createdAt).length === 0) delete where.createdAt;
        }
        if (req.query.search) {
            const search = `%${String(req.query.search).trim()}%`;
            where[Op.or] = [
                { ticketId: { [Op.iLike]: search } },
                { recipientEmail: { [Op.iLike]: search } },
                { reminderType: { [Op.iLike]: search } },
            ];
        }

        const logs = await ReminderLog.findAll({
            where,
            order: [["createdAt", "DESC"]],
            limit,
        });

        return res.json({ success: true, data: logs });
    } catch (e) {
        return res.status(e.statusCode || 500).json({
            success: false,
            message: e.message || "Failed to load reminder logs",
        });
    }
};

exports.sendReminderTestEmail = async (req, res) => {
    try {
        const staff = await getCurrentStaff(req);
        if (roleLower(staff) !== "superadmin") {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const email = String(staff.email || "").trim();
        if (!email) {
            return res.status(400).json({ success: false, message: "Superadmin email is missing" });
        }

        const result = await sendMail({
            to: email,
            subject: buildTicketSubject("TEST", "Reminder email test"),
            html: renderEmailLayout({
                title: "Reminder Email Test",
                intro: "This is a test email from MET Helpdesk reminder settings.",
                rows: [
                    { label: "Sent To", value: email },
                    { label: "Purpose", value: "Verify reminder email configuration" },
                    { label: "Result", value: "Email service accepted this test message" },
                ],
                outro: "No ticket data was changed for this test.",
            }),
        });

        if (result?.skipped) {
            return res.json({
                success: true,
                data: { skipped: true, reason: result.reason },
                message: "Email is disabled, so test email was skipped.",
            });
        }

        return res.json({
            success: true,
            data: { sent: true, to: email },
            message: "Test reminder email sent.",
        });
    } catch (e) {
        return res.status(e.statusCode || 500).json({
            success: false,
            message: e.message || "Failed to send test reminder email",
        });
    }
};

exports.rephraseText = async (req, res) => {
    try {
        const text = String(req.body?.text || "");
        const format = String(req.body?.format || "text").toLowerCase();

        if (!text.trim()) {
            return res.status(400).json({ success: false, message: "Text is required" });
        }

        const rephrased = rephraseSentence(text);

        return res.json({
            success: true,
            data: {
                text: format === "html" && rephrased ? `<p>${rephrased}</p>` : rephrased,
            },
        });
    } catch (e) {
        return res.status(500).json({
            success: false,
            message: e.message || "Failed to rephrase text",
        });
    }
};
