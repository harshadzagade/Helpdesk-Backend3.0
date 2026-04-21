const { Op } = require('sequelize');
const Department = require('../models/department');

// helpers
const normalizeCategory = (input) => {
  if (Array.isArray(input)) return input.filter(Boolean).map(s => String(s).trim());
  if (typeof input === 'string') return input.split(',').map(s => s.trim()).filter(Boolean);
  return undefined;
};

// CREATE (Superadmin only — double-guarded)
exports.createDepartment = async (req, res) => {
  try {
    // extra guard in controller (besides middleware)
    if (!req.user || req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Only superadmin can create departments' });
    }

    const { department, type, category } = req.body;

    if (!department || !department.trim()) {
      return res.status(400).json({ message: 'department is required' });
    }
    if (!type || !type.trim()) {
      return res.status(400).json({ message: 'type is required' });
    }

    // Normalize category to always be an array
    const cat = normalizeCategory(category);
    const finalCat = (cat && cat.length) ? cat : ['N/A'];

    // unique on (department, type)
    const exists = await Department.findOne({
      where: { department: department.trim(), type: type.trim() }
    });
    if (exists) return res.status(409).json({ message: 'Department with this type already exists' });

    const created = await Department.create({
      department: department.trim(),
      type: type.trim(),
      category: finalCat // This will now always be an array
    });

    res.status(201).json({ message: 'Department created', data: created });
  } catch (err) {
    res.status(500).json({ message: 'Create failed', error: err.message });
  }
};

// LIST with search & pagination
exports.getDepartments = async (req, res) => {
  try {
    const departmentData = await Department.findAll();
    res.status(200).json(departmentData);
    if (!departmentData) {
      res.status(404).json({ message: 'No departments found' });
    }
  } catch (error) {
    console.error('Error fetching departments:', error);
    res.status(500).json({ message: 'Fetch failed', error: error.message });
  }
};

// READ by id
exports.getDepartmentById = async (req, res) => {
  try {
    const item = await Department.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Department not found' });
    res.json({ data: item });
  } catch (err) {
    res.status(500).json({ message: 'Fetch failed', error: err.message });
  }
};

// UPDATE
exports.updateDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await Department.findByPk(id);
    if (!item) return res.status(404).json({ message: 'Department not found' });

    const { department, type, category } = req.body;

    if (department && department.trim()) item.department = department.trim();
    if (type && type.trim()) item.type = type.trim();
    if (category !== undefined) {
      const cat = normalizeCategory(category);
      item.category = (cat && cat.length) ? cat : ['N/A'];
    }
    

    // uniqueness check on (department, type)
    const dupe = await Department.findOne({
      where: {
        department: item.department,
        type: item.type,
        id: { [Op.ne]: id }
      }
    });
    if (dupe) return res.status(409).json({ message: 'Department with this type already exists' });

    await item.save();
    res.json({ message: 'Department updated', data: item });
  } catch (err) {
    res.status(500).json({ message: 'Update failed', error: err.message });
  }
};

// DELETE (hard delete)
exports.deleteDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await Department.findByPk(id);
    if (!item) return res.status(404).json({ message: 'Department not found' });

    await item.destroy();
    res.json({ message: 'Department deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Delete failed', error: err.message });
  }
};
