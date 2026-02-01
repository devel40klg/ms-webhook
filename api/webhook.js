// Формат для Vercel Serverless Functions
import axios from 'axios';

// Конфигурация с вашими данными
const MOYSKLAD_API_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MOYSKLAD_TOKEN = 'cd6386cffc18df197c31818ef755b186a2f3da9a';

// Склады в порядке приоритета проверки: 1) Москва, 2) СПБ, 3) Интернет-магазин
const WAREHOUSE_IDS = {
  MSK: '495124d9-e42f-11ed-0a80-0f480010433d', // Склад Мск одежда
  SPB: '064ae98f-f40f-11e9-0a80-012300093c25', // Склад Спб
  ONLINE: 'cf17c34e-d5ad-11f0-0a80-1b37000abc53' // Интернет-магазин
};

// Порядок проверки остатков: сначала Москва, потом СПБ, потом Интернет-магазин
const WAREHOUSE_ORDER = ['MSK', 'SPB', 'ONLINE'].filter(key => WAREHOUSE_IDS[key]);

// Задержка между запросами к API (мс), чтобы не упираться в лимиты МойСклад
const API_DELAY_MS = 300;

// Создаем экземпляр axios с настройками
const axiosInstance = axios.create({
  baseURL: MOYSKLAD_API_URL,
  headers: {
    'Authorization': `Bearer ${MOYSKLAD_TOKEN}`,
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

// Задержка между запросами к API (соблюдение лимитов обмена)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Вспомогательная функция для извлечения ID из ссылки
function extractIdFromHref(href) {
  if (!href) return null;
  const parts = href.split('/');
  return parts[parts.length - 1];
}

// Функция для изменения склада в заказе
async function changeOrderWarehouse(orderId, newWarehouseId) {
  try {
    console.log(`Изменение склада в заказе ${orderId} на ${newWarehouseId}`);
    
    const updateData = {
      store: {
        meta: {
          href: `${MOYSKLAD_API_URL}/entity/store/${newWarehouseId}`,
          type: 'store',
          mediaType: 'application/json'
        }
      }
    };

    const response = await axiosInstance.put(`/entity/customerorder/${orderId}`, updateData);
    console.log('✅ Склад успешно изменен:', response.data.name);
    return response.data;
  } catch (error) {
    console.error('❌ Ошибка при изменении склада:', error.message);
    throw error;
  }
}

// Функция для проверки остатков товара на складе (с правильным фильтром)
async function checkStockOnWarehouse(productId, productType, warehouseId) {
  try {
    console.log(`🔍 Проверка остатков: ${productId} (${productType}), склад ${warehouseId}`);
    
    let filter = '';
    
    // Создаем правильный фильтр в зависимости от типа товара
    if (productType === 'variant') {
      filter = `variant=${MOYSKLAD_API_URL}/entity/variant/${productId}`;
    } else if (productType === 'product') {
      filter = `product=${MOYSKLAD_API_URL}/entity/product/${productId}`;
    } else if (productType === 'service') {
      console.log(`↪️ Пропускаем услугу ${productId}`);
      return 999; // Возвращаем большое число для услуг, чтобы они всегда были "в наличии"
    } else {
      console.log(`⚠️ Неизвестный тип товара: ${productType}, пробуем как variant`);
      filter = `variant=${MOYSKLAD_API_URL}/entity/variant/${productId}`;
    }
    
    // Добавляем фильтр по складу (правильный синтаксис)
    const fullFilter = `${filter};store=${MOYSKLAD_API_URL}/entity/store/${warehouseId}`;
    
    console.log(`Фильтр: ${fullFilter}`);
    
    // Делаем запрос к расширенному отчету
    const response = await axiosInstance.get(
      `/report/stock/all?filter=${fullFilter}`
    );
    
    console.log(`Ответ получен, строк: ${response.data.rows?.length || 0}`);

    if (response.data.rows && response.data.rows.length > 0) {
      // Берем первую запись (должна быть только одна для данного товара на данном складе)
      const stock = response.data.rows[0].stock || 0;
      console.log(`✅ Найдено остатков на складе ${warehouseId}: ${stock}`);
      return stock;
    }

    console.log(`❌ Товар не найден на складе ${warehouseId} (0 остатков)`);
    return 0;

  } catch (error) {
    console.error(`Ошибка при проверке остатков для ${productId}:`, error.message);
    if (error.response) {
      console.error('Статус:', error.response.status);
      console.error('Данные:', error.response.data);
      
      // Если ошибка 412, пробуем альтернативный подход
      if (error.response.status === 412) {
        console.log('⚠️ Пробуем альтернативный подход без фильтра по складу...');
        return await checkStockAlternative(productId, productType, warehouseId);
      }
    }
    return 0;
  }
}

// Альтернативная функция проверки остатков (без фильтра по складу в URL)
async function checkStockAlternative(productId, productType, warehouseId) {
  try {
    console.log(`🔍 Альтернативная проверка для ${productId} (${productType})`);
    
    let filter = '';
    
    if (productType === 'variant') {
      filter = `variant=${MOYSKLAD_API_URL}/entity/variant/${productId}`;
    } else if (productType === 'product') {
      filter = `product=${MOYSKLAD_API_URL}/entity/product/${productId}`;
    } else {
      filter = `variant=${MOYSKLAD_API_URL}/entity/variant/${productId}`;
    }
    
    // Запрашиваем без фильтра по складу
    const response = await axiosInstance.get(
      `/report/stock/all?filter=${filter}`
    );
    
    console.log(`Ответ получен, строк: ${response.data.rows?.length || 0}`);
    
    if (response.data.rows && response.data.rows.length > 0) {
      // Ищем нужный склад среди всех
      const stockItem = response.data.rows.find(row => {
        // Проверяем разными способами
        return (row.store && row.store.id === warehouseId) ||
               (row.storeId === warehouseId) ||
               (row.store && row.store.meta && row.store.meta.href && 
                row.store.meta.href.includes(warehouseId));
      });
      
      if (stockItem) {
        const stock = stockItem.stock || 0;
        console.log(`✅ Найдено остатков на складе ${warehouseId}: ${stock}`);
        return stock;
      }
    }
    
    console.log(`❌ Товар не найден на складе ${warehouseId}`);
    return 0;
    
  } catch (error) {
    console.error(`Ошибка в альтернативной проверке для ${productId}:`, error.message);
    return 0;
  }
}

// Основной обработчик
export default async function handler(req, res) {
  // Разрешаем только POST запросы
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const requestTime = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    console.log(`=== НОВЫЙ ВЕБХУК ПОЛУЧЕН === ${requestTime} (МСК)`);
    
    // Проверяем наличие события
    if (!req.body.events || req.body.events.length === 0) {
      return res.status(400).json({ error: 'Нет событий в вебхуке' });
    }

    // Получаем информацию о заказе из вебхука
    const orderMeta = req.body.events[0].meta;
    if (!orderMeta?.href) {
      return res.status(400).json({ error: 'Неверный формат вебхука' });
    }

    // Извлекаем ID заказа из URL
    const orderId = orderMeta.href.split('/').pop();
    console.log(`ID заказа: ${orderId}`);
    
    // Получаем полные данные заказа
    console.log('Получаем детали заказа из МойСклад...');
    const orderResponse = await axiosInstance.get(`/entity/customerorder/${orderId}?expand=positions`);
    const order = orderResponse.data;
    
    console.log(`Заказ: ${order.name}`);
    console.log(`Общее количество позиций: ${order.positions?.rows?.length || 0}`);
    
    // Получаем ID склада
    let currentWarehouseId = null;
    if (order.store && order.store.meta && order.store.meta.href) {
      currentWarehouseId = order.store.meta.href.split('/').pop();
    }
    
    console.log(`ID склада в заказе: ${currentWarehouseId || 'Не указан'}`);
    
    // Собираем позиции для проверки (товары и варианты; услуги и комплекты пропускаем)
    const positionsToCheck = [];
    if (order.positions && order.positions.rows) {
      for (const position of order.positions.rows) {
        const assortment = position.assortment;
        if (!assortment) continue;

        let productId = assortment.id;
        if (!productId && assortment.meta?.href) productId = extractIdFromHref(assortment.meta.href);
        if (!productId) continue;

        const productType = assortment.meta?.type;
        if (productType === 'bundle') continue;

        positionsToCheck.push({
          productId,
          productType,
          productName: assortment.name || 'Неизвестный товар',
          quantity: position.quantity
        });
      }
    }

    if (positionsToCheck.length === 0) {
      console.log(`📭 В заказе нет товаров для проверки (только услуги/комплекты), оставляем как есть`);
      if (!currentWarehouseId) {
        try {
          await changeOrderWarehouse(orderId, WAREHOUSE_IDS.MSK);
        } catch (e) {
          console.log(`⚠️ Не удалось установить склад: ${e.message}`);
        }
      }
      return res.status(200).json({
        success: true,
        message: 'Нет товаров для проверки',
        order: order.name,
        warehouse: currentWarehouseId ? 'текущий' : 'МСК'
      });
    }

    // Если склад не указан или не из нашего списка — ставим МСК по умолчанию
    if (!currentWarehouseId || !Object.values(WAREHOUSE_IDS).includes(currentWarehouseId)) {
      console.log(`🔧 Заказ без склада или с неизвестным складом, устанавливаем МСК...`);
      try {
        await changeOrderWarehouse(orderId, WAREHOUSE_IDS.MSK);
        currentWarehouseId = WAREHOUSE_IDS.MSK;
      } catch (error) {
        console.log(`⚠️ Не удалось изменить склад: ${error.message}`);
      }
    }

    // Ищем первый склад по приоритету (МСК → СПБ → Интернет-магазин), где есть ВСЕ товары
    const warehouseLabels = { MSK: 'МСК', SPB: 'СПБ', ONLINE: 'Интернет-магазин' };
    let targetWarehouseKey = null;
    const stockByWarehouse = {};

    for (const whKey of WAREHOUSE_ORDER) {
      const whId = WAREHOUSE_IDS[whKey];
      console.log(`\n🔍 Проверяем склад: ${warehouseLabels[whKey] || whKey} (${whId})`);

      let allEnough = true;
      for (const pos of positionsToCheck) {
        if (pos.productType === 'service') continue;

        if (!stockByWarehouse[pos.productId]) stockByWarehouse[pos.productId] = {};
        let qty = stockByWarehouse[pos.productId][whKey];
        if (qty === undefined) {
          qty = await checkStockOnWarehouse(pos.productId, pos.productType, whId);
          stockByWarehouse[pos.productId][whKey] = qty;
          await delay(API_DELAY_MS);
        }

        if (qty < pos.quantity) {
          console.log(`   ❌ ${pos.productName}: нужно ${pos.quantity}, на складе ${qty}`);
          allEnough = false;
          break;
        }
        console.log(`   ✅ ${pos.productName}: ${qty} >= ${pos.quantity}`);
      }

      if (allEnough) {
        targetWarehouseKey = whKey;
        console.log(`✅ Все позиции есть на складе ${warehouseLabels[whKey] || whKey}`);
        break;
      }
    }

    if (!targetWarehouseKey) {
      console.log(`⚠️ Нет склада, где все товары в наличии. Оставляем текущий склад.`);
      return res.status(200).json({
        success: true,
        message: 'Нет склада с полным наличием, склад не меняем',
        order: order.name,
        warehouse: 'текущий'
      });
    }

    const targetWarehouseId = WAREHOUSE_IDS[targetWarehouseKey];
    if (currentWarehouseId === targetWarehouseId) {
      console.log(`✅ Заказ уже на складе ${warehouseLabels[targetWarehouseKey]}, ничего не меняем`);
      return res.status(200).json({
        success: true,
        message: `Заказ уже на складе ${warehouseLabels[targetWarehouseKey]}`,
        order: order.name,
        warehouse: warehouseLabels[targetWarehouseKey]
      });
    }

    try {
      await changeOrderWarehouse(orderId, targetWarehouseId);
      console.log(`🔄 Склад изменён на ${warehouseLabels[targetWarehouseKey]}`);
      return res.status(200).json({
        success: true,
        message: `Склад изменён на ${warehouseLabels[targetWarehouseKey]}`,
        order: order.name,
        oldWarehouse: Object.entries(WAREHOUSE_IDS).find(([, id]) => id === currentWarehouseId)?.[0] || 'текущий',
        newWarehouse: warehouseLabels[targetWarehouseKey],
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error(`❌ Ошибка при смене склада: ${error.message}`);
      return res.status(500).json({
        error: 'Ошибка при изменении склада',
        details: error.message,
        order: order.name
      });
    }

  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', error.message);
    if (error.response) {
      console.error('Статус:', error.response.status);
      console.error('Данные:', error.response.data);
    }
    
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message
    });
  }
}

export const config = {
  api: {
    bodyParser: true
  }
};
