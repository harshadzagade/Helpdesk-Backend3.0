const bcrypt = require('bcryptjs');
const Staff = require('../models/staff');

const seedSuperAdmin = async () => {
  try {
    const email = 'superadmin@helpdesk.com';

    const existingAdmin = await Staff.findOne({ where: { email } });
    if (existingAdmin) {
      console.log('✅ Superadmin already exists');
      return;
    }

    const hashedPassword = await bcrypt.hash('12345678', 10);

    await Staff.create({
      firstname: 'Super',
      middlename: '',
      lastname: 'Admin',
      email,
      password: hashedPassword,
      role: 'superadmin',

      instituteId: 1,        // 🔴 kisi bhi valid institute ka ID
      departmentIds: [],     // ✅ EMPTY = ALL departments access

      employeeType: 'Management',
      phoneNumber: 9999999999,
      contactExtension: '001',
      isNew: false
    });

    console.log('✅ Superadmin seeded successfully');
  } catch (error) {
    console.error('❌ Error seeding Superadmin:', error.message);
  }
};

module.exports = seedSuperAdmin;
