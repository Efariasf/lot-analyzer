export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { mode, fields } = req.body;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'API key no configurada' });

  try {
    const { lot, year, make, model, vin, titleType, auction, miles, milesStatus,
            damages, dashLights, dashCustom, observations, mechanicalStatus,
            offerMin, offerMax, buyNow, reservePrice } = fields;

    // Estado mecánico — solo indicamos lo que Copart dice, sin garantizar nada
    const mechMap = {
      'no-enciende': 'El vehículo no enciende.',
      'enciende-no-rueda': 'Copart verificó que el motor enciende, sin embargo el vehículo no rueda, lo que podría indicar algún tipo de falla mecánica como transmisión u otro problema relacionado.',
      'enciende-rueda': 'Copart verificó que el motor enciende y la transmisión engrana.'
    };
    const mechText = mechMap[mechanicalStatus] || '';

    const isDestruction = titleType === 'Certificate of Destruction / Junk';
    const destructionWarning = isDestruction
      ? 'Este vehículo posee un título Certificate of Destruction (Junk), lo que significa que JAMÁS podrá circular legalmente en las carreteras de Estados Unidos. Solo puede ser utilizado para chatarra o venta de piezas.'
      : '';

    const REPORT_LINK = 'https://t.me/reporteexpressbot';
    const buyNowText = buyNow ? `\nTiene precio de compra inmediata (Buy Now) de $${buyNow}.` : '';
    const reserveText = reservePrice ? `\nTiene precio de reserva de $${reservePrice}.` : '';

    const damageList = Array.isArray(damages) && damages.length > 0 ? damages : [];
    // Limpiar prefijos redundantes para el texto (ej: "Daño trasero" → "trasero")
    const damageTextClean = damageList.map(d => d.replace(/^Daño\s+/i, '')).join(', ');
    const damageText = damageList.join(', ');

    const lightsMap = {
      'none': '',
      'check-engine': 'Check engine encendido — podría indicar algún tipo de falla mecánica o electrónica.',
      'airbag': 'Luz de airbag/SRS encendida — podría indicar detonación de airbags o falla en el sistema de seguridad.',
      'transmission': 'Luz de transmisión encendida — podría indicar algún tipo de falla en la caja automática.',
      'abs': 'Luz de ABS encendida — podría indicar algún tipo de falla en el sistema de frenos antibloqueo.',
      'battery': 'Luz de batería encendida — podría indicar falla en el alternador, batería o sistema eléctrico.',
      'oil': 'Luz de aceite encendida — podría indicar baja presión de aceite o falla en el sistema de lubricación.',
      'temperature': 'Luz de temperatura encendida — podría indicar sobrecalentamiento del motor.',
      'multiple': 'Múltiples luces del tablero encendidas — esto podría estar indicando algún tipo de falla o daño mecánico.',
      'custom': dashCustom ? `${dashCustom} encendido — podría indicar algún tipo de falla mecánica o electrónica.` : ''
    };
    const lightsText = lightsMap[dashLights] || '';

    const isTitleClean = titleType === 'Clean';
    const hasHail = damageList.includes('Granizo');
    const salvageTriggers = ['Inundación/Agua', 'Vandalismo', 'Fuego'];
    const hasSalvageTrigger = damageList.some(d => salvageTriggers.includes(d));

    let salvageWarning = '';
    if (isTitleClean) {
      if (hasHail && !hasSalvageTrigger) {
        salvageWarning = `Daño por granizo suele recibir automáticamente un título salvage al momento de registrarse. Sin embargo, en Texas normalmente conserva un título clean. Aun así, recomendamos contactar al DMV para confirmar si, al momento de registrar el vehículo, mantendría el título clean o si podría cambiar a salvage.`;
      } else if (hasHail && hasSalvageTrigger) {
        const extra = damageList.filter(d => salvageTriggers.includes(d)).join(', ');
        salvageWarning = `Dado que presenta granizo y ${extra}, existe una alta probabilidad de que el título cambie a salvage al momento de registrarse dependiendo del estado. En Texas el granizo normalmente conserva título clean, pero los daños adicionales pueden cambiar esto. Recomendamos contactar al DMV para confirmarlo antes de adquirirlo.`;
      } else if (hasSalvageTrigger) {
        const triggerNames = damageList.filter(d => salvageTriggers.includes(d)).join(', ');
        salvageWarning = `Dado que presenta ${triggerNames}, existe la posibilidad de que al momento de registrar el vehículo el título cambie a salvage dependiendo del estado donde sea registrado. Recomendamos contactar al DMV local para confirmar esto antes de adquirirlo.`;
      }
    }

    const prompt = `Eres un broker experto de subastas de vehículos salvage (Copart, IAAI, Manheim). Redacta un análisis profesional en español para enviar por WhatsApp a un cliente. Debe ser CONCISO. Texto plano, sin markdown, sin asteriscos, sin guiones al inicio, sin emojis.

REGLAS IMPORTANTES:
- Título Clean significa solo que NO fue declarado pérdida total por aseguradora. NO menciones historial ni reportes previos.
- NUNCA digas que el vehículo "rueda correctamente" ni uses la palabra "correctamente" — solo indica lo que dice la subasta.
- NUNCA uses "Dado que presenta daño por Daño" — usa solo el tipo sin repetir la palabra daño.
- Sé directo y profesional.

Usa EXACTAMENTE esta estructura (respeta saltos de línea, NO modifiques los textos marcados INSERTAR TAL CUAL):

${lot} - ${year} ${make.toUpperCase()} ${model.toUpperCase()}
[2-3 oraciones: título "${titleType}" en ${auction} — explica qué significa sin mencionar historial, daños "${damageTextClean}", millas ${miles} (${milesStatus}), estado general.]
${salvageWarning ? `INSERTAR TAL CUAL: ${salvageWarning}` : ''}
${destructionWarning ? `INSERTAR TAL CUAL: ${destructionWarning}` : ''}
${lightsText ? `[1 oración sobre: ${lightsText}]` : ''}
${mechText ? `INSERTAR TAL CUAL: ${mechText}` : ''}
${observations ? `[Mejora y redacta profesionalmente estas observaciones del broker: ${observations}]` : ''}

Ofertaría entre $${offerMin} a $${offerMax}
${buyNowText}${reserveText}

VIN: ${vin}
Solicite su REPORTE aquí:
${REPORT_LINK}

Es siempre recomendable revisar el Reporte de Carfax para verificar el tipo de título, millas, servicios realizados, accidentes reportados, y propietarios anteriores.
CARFAX NO DA INFORMACIÓN DE DAÑOS MECÁNICOS NI OCULTOS`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.3
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(500).json({ error: data?.error?.message || 'Error de Groq' });
    const text = data?.choices?.[0]?.message?.content || '';
    return res.status(200).json({ result: text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
