const { Sequelize } = require('sequelize');
const logger = require('./logger');

const sequelize = new Sequelize({
  dialect: process.env.DB_DIALECT || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  logging: msg => logger.debug(msg),
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
});

// Define models
const Call = sequelize.define('Call', {
  id: {
    type: Sequelize.UUID,
    defaultValue: Sequelize.UUIDV4,
    primaryKey: true
  },
  call_id: {
    type: Sequelize.STRING,
    allowNull: false
  },
  session_id: {
    type: Sequelize.STRING,
    allowNull: false
  },
  direction: {
    type: Sequelize.STRING,
    allowNull: false
  },
  from_number: {
    type: Sequelize.STRING,
    allowNull: false
  },
  to_number: {
    type: Sequelize.STRING,
    allowNull: false
  },
  start_time: {
    type: Sequelize.DATE,
    allowNull: false
  },
  end_time: {
    type: Sequelize.DATE,
    allowNull: true
  },
  duration: {
    type: Sequelize.INTEGER,
    allowNull: true
  },
  status: {
    type: Sequelize.STRING,
    allowNull: false
  },
  call_data: {
    type: Sequelize.JSONB,
    allowNull: true
  }
}, {
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

const Message = sequelize.define('Message', {
  id: {
    type: Sequelize.UUID,
    defaultValue: Sequelize.UUIDV4,
    primaryKey: true
  },
  call_id: {
    type: Sequelize.UUID,
    allowNull: false,
    references: {
      model: Call,
      key: 'id'
    }
  },
  role: {
    type: Sequelize.STRING,
    allowNull: false
  },
  text: {
    type: Sequelize.TEXT,
    allowNull: false
  },
  timestamp: {
    type: Sequelize.DATE,
    allowNull: false
  }
}, {
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false // Messages are immutable, only created
});

// Define relationships
Call.hasMany(Message, { foreignKey: 'call_id', as: 'messages' });
Message.belongsTo(Call, { foreignKey: 'call_id', as: 'call' });

// Database service methods
const dbService = {
  async init() {
    try {
      await sequelize.authenticate();
      logger.info('Database connection has been established successfully.');
      
      // Sync models with database (in production, use migrations instead)
      // Consider adding a check for process.env.NODE_ENV === 'development'
      // if (process.env.NODE_ENV !== 'production') {
      //    await sequelize.sync({ alter: true }); // Use alter:true for non-destructive updates
      //    logger.info('Database models synchronized.');
      // }
      // For simplicity in this context, we'll sync regardless. Be cautious in production.
      await sequelize.sync({ alter: true });
      logger.info('Database models synchronized.');

      return true;
    } catch (error) {
      logger.error('Unable to connect to the database:', error);
      return false;
    }
  },
  
  async saveCall(callData) {
    try {
      const call = await Call.create(callData);
      return call;
    } catch (error) {
      logger.error('Error saving call to database:', error);
      return null;
    }
  },
  
  async updateCall(id, updateData) {
    try {
      const [updated] = await Call.update(updateData, {
        where: { id }
      });
      return updated > 0;
    } catch (error) {
      logger.error('Error updating call in database:', error);
      return false;
    }
  },
  
  // Update or Create Call by external ID
  async upsertCallByExternalId(call_id, callData) {
    try {
      const existingCall = await Call.findOne({ where: { call_id } });
      if (existingCall) {
        // Merge new data, excluding primary key and potentially immutable fields
        const { id, ...updateData } = callData;
        await Call.update(updateData, { where: { call_id } });
        return await Call.findByPk(existingCall.id); // Return updated record
      } else {
        return await Call.create(callData);
      }
    } catch (error) {
      logger.error('Error upserting call by external ID:', error);
      return null;
    }
  },

  async saveMessages(messages) {
    try {
      // Ensure call_id is present and timestamps are Date objects
      const preparedMessages = messages.map(msg => ({
        ...msg,
        timestamp: new Date(msg.timestamp) // Ensure it's a Date object
      }));
      await Message.bulkCreate(preparedMessages);
      return true;
    } catch (error) {
      logger.error('Error saving messages to database:', error);
      return false;
    }
  },
  
  async getCallWithMessages(id) {
    try {
      const call = await Call.findByPk(id, {
        include: [{ model: Message, as: 'messages', order: [['timestamp', 'ASC']] }]
      });
      return call;
    } catch (error) {
      logger.error('Error getting call with messages from database:', error);
      return null;
    }
  },
  
  async getCallByExternalId(call_id) {
    try {
      const call = await Call.findOne({
        where: { call_id },
        include: [{ model: Message, as: 'messages', order: [['timestamp', 'ASC']] }]
      });
      return call;
    } catch (error) {
      logger.error('Error getting call by external ID from database:', error);
      return null;
    }
  }
};

module.exports = { sequelize, Call, Message, dbService }; 