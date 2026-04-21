const { Op } = require('sequelize');
const Institute = require('../models/institute');

// Create
exports.createInstitute = async (req, res) => {
  try {
    const { institute } = req.body;
    if (!institute || !institute.trim()) {
      return res.status(400).json({ message: 'institute field is required' });
    }

    const payload = { institute: institute.trim() };

    const exists = await Institute.findOne({
      where: { institute: payload.institute }
    });
    if (exists) return res.status(409).json({ message: 'Institute already exists' });

    const created = await Institute.create(payload);
    res.status(201).json({ message: 'Institute created', data: created });
  } catch (err) {
    res.status(500).json({ message: 'Create failed', error: err.message });
  }
};

exports.getInstitutes = async (req, res) => {
  try {
    const instituteData = await Institute.findAll();
    res.status(200).json(instituteData);
    if (!instituteData) {
      res.status(404).json({ message: 'No institutes found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
    console.error(error);
  }
}

// List (with search & pagination)
// exports.getInstitutes = async (req, res) => {
//   try {
//     const { q = '', page = 1, limit = 20 } = req.query;
//     const where = q
//       ? { institute: { [Op.iLike]: `%${q}%` } } // use Op.substring for MySQL
//       : {};

//     const offset = (Number(page) - 1) * Number(limit);

//     const { rows, count } = await Institute.findAndCountAll({
//       where,
//       offset,
//       limit: Number(limit),
//       order: [['id', 'DESC']]
//     });

//     res.json({
//       data: rows,
//       pagination: {
//         total: count,
//         page: Number(page),
//         pages: Math.ceil(count / Number(limit)),
//         limit: Number(limit)
//       }
//     });
//   } catch (err) {
//     res.status(500).json({ message: 'Fetch failed', error: err.message });
//   }
// };

// Read (by id)
exports.getInstituteById = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await Institute.findByPk(id);
    if (!item) return res.status(404).json({ message: 'Institute not found' });
    res.json({ data: item });
  } catch (err) {
    res.status(500).json({ message: 'Fetch failed', error: err.message });
  }
};

// Update
exports.updateInstitute = async (req, res) => {
  try {
    const { id } = req.params;
    const { institute } = req.body;

    const item = await Institute.findByPk(id);
    if (!item) return res.status(404).json({ message: 'Institute not found' });

    if (institute && institute.trim()) {
      // optional uniqueness check
      const exists = await Institute.findOne({
        where: {
          institute: institute.trim(),
          id: { [Op.ne]: id }
        }
      });
      if (exists) return res.status(409).json({ message: 'Institute name already used' });
      item.institute = institute.trim();
    }

    await item.save();
    res.json({ message: 'Institute updated', data: item });
  } catch (err) {
    res.status(500).json({ message: 'Update failed', error: err.message });
  }
};

// Delete (hard delete)
exports.deleteInstitute = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await Institute.findByPk(id);
    if (!item) return res.status(404).json({ message: 'Institute not found' });

    await item.destroy();
    res.json({ message: 'Institute deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Delete failed', error: err.message });
  }
};
