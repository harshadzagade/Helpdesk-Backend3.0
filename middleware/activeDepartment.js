// middleware/activeDepartment.js
module.exports = async function activeDepartment(req, res, next) {
  try {
    const raw = req.headers["x-department-id"] || req.query.departmentId;

    if (!req.user?.id) return res.status(401).json({ message: "Unauthorized" });

    const allowed = Array.isArray(req.user.departmentIds) ? req.user.departmentIds : [];
    const deptId = raw ? Number(raw) : null;

    // superadmin => allow all
    if (String(req.user.role || "").toLowerCase() === "superadmin") {
      if (!deptId || Number.isNaN(deptId)) {
        return res.status(400).json({ message: "x-department-id (departmentId) is required" });
      }
      req.departmentId = deptId;
      return next();
    }

    if ((!deptId || Number.isNaN(deptId)) && allowed.length === 1) {
      req.departmentId = Number(allowed[0]);
      return next();
    }

    if (!deptId || Number.isNaN(deptId)) {
      return res.status(400).json({ message: "x-department-id (departmentId) is required" });
    }

    if (!allowed.includes(deptId)) {
      return res.status(403).json({ message: "Not allowed for this department" });
    }

    req.departmentId = deptId;
    next();
  } catch (err) {
    console.error("activeDepartment error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
