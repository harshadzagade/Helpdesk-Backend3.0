// controller/subadminActivity.js
const { Op } = require("sequelize");
const SubadminActivity = require("../models/subadminActivity");
const Staff = require("../models/staff");
const Department = require("../models/department");

// ✅ helper: current staff (req.user.id ya query/body se)
const getCurrentStaff = async (req) => {
  const staffId = req.user?.id || req.query.staffId || req.body.staffId;

  if (!staffId) {
    const err = new Error("staffId missing (auth ya query/body me send karo)");
    err.statusCode = 400;
    throw err;
  }

  const staff = await Staff.findByPk(staffId);
  if (!staff) {
    const err = new Error(`Staff not found for id: ${staffId}`);
    err.statusCode = 404;
    throw err;
  }

  return staff;
};


exports.getSubadminActivities = async (req, res) => {
  try {
    const currentStaff = await getCurrentStaff(req);

    // ✅ Sirf admin / superadmin hi dekh sakte
    const role = String(currentStaff.role || "").toLowerCase();
    if (role !== "admin" && role !== "superadmin") {
      return res.status(403).json({
        success: false,
        message: "Only admin/superadmin can view subadmin activities.",
      });
    }

    // ✅ activeDepartment middleware se deptId aayega (header/query validate karke)
    const activeDeptId = req.departmentId || Number(req.headers["x-department-id"] || req.query.departmentId);

    if (!activeDeptId || Number.isNaN(activeDeptId)) {
      return res.status(400).json({
        success: false,
        message: "x-department-id (departmentId) is required",
      });
    }

    // ✅ Filters from query
    const { subadminId, actionTaken, from, to } = req.query;

    const where = {
      departmentId: activeDeptId,
    };

    if (subadminId) {
      const sid = parseInt(subadminId, 10);
      if (!Number.isNaN(sid)) where.subadminId = sid;
    }

    if (actionTaken) where.actionTaken = actionTaken;

    // ✅ Date range filter
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt[Op.gte] = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        where.createdAt[Op.lte] = end;
      }
    }
    
    console.log('SubadminActivity associations:', Object.keys(SubadminActivity.associations));

    const activities = await SubadminActivity.findAll({
      where,
      attributes: ["id", "subadminId", "departmentId", "actionTaken", "entityType", "entityId", "createdAt"],
      include: [
        {
          model: Staff,
          as: "subadmin",
          attributes: ["id", "firstname", "middlename", "lastname", "email"],
        },
        {
          model: Department,
          attributes: ["id", "department"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });
    

    return res.status(200).json({
      success: true,
      data: activities,
      departmentId: activeDeptId,
    });
  } catch (error) {
    console.error("Error in getSubadminActivities:", error);

    const statusCode = error.statusCode || 500;

    return res.status(statusCode).json({
      success: false,
      message:
        statusCode !== 500
          ? error.message
          : "Failed to fetch subadmin activities",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : statusCode === 500
          ? "Internal server error"
          : undefined,
    });
  }
};
