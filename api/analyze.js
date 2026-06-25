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
            offerMin, offerMax, buyNow, reservePrice, copartGo, externalLot, tituloAusente, fechaFuturo } = fields;

    const REPORT_LINK = 'https://t.me/reporteexpressbot';

    // Daños
    const damageList = Array.isArray(damages) && damages.length > 0 ? damages : [];
    const damageTextClean = damageList.map(d => d.replace(/^Daño\s+/i, '')).join(', ');

    // Estado mecánico
    const mechMap = {
      'no-enciende': 'El vehículo no enciende.',
      'enciende-no-rueda': 'Copart verificó que el motor enciende, sin embargo el vehículo no rueda, lo que podría indicar algún tipo de falla mecánica como transmisión u otro problema relacionado.',
      'enciende-rueda': 'Copart verificó que el motor enciende y la transmisión engrana.'
    };
    const mechText = mechMap[mechanicalStatus] || '';

    // Luces
    const lightsMap = {
      'check-engine': 'Check engine encendido — podría indicar algún tipo de falla mecánica o electrónica.',
      'airbag': 'Luz de airbag/SRS encendida — podría indicar detonación de airbags o falla en el sistema de seguridad.',
      'transmission': 'Luz de transmisión encendida — podría indicar algún tipo de falla en la caja automática.',
      'abs': 'Luz de ABS encendida — podría indicar algún tipo de falla en el sistema de frenos antibloqueo.',
      'battery': 'Luz de batería encendida — podría indicar falla en el alternador, batería o sistema eléctrico.',
      'oil': 'Luz de aceite encendida — podría indicar baja presión de aceite o falla en el sistema de lubricación.',
      'temperature': 'Luz de temperatura encendida — podría indicar sobrecalentamiento del motor.',
      'multiple': 'Múltiples luces del tablero encendidas — esto podría indicar algún tipo de daño eléctrico o falla mecánica en el vehículo.',
      'custom': dashCustom ? `${dashCustom} encendido — podría indicar algún tipo de falla mecánica o electrónica.` : ''
    };
    const lightsArray = Array.isArray(dashLights) ? dashLights : (dashLights && dashLights !== 'none' ? [dashLights] : []);
    const lightsLines = lightsArray.map(l => lightsMap[l] || '').filter(Boolean);
    const noLightsText = lightsLines.length === 0 ? 'No presenta luces de motor ni airbag encendidas en el tablero.' : '';

    // Millas
    const milesStatusMap = {
      'No actuales (TMU)': 'Las millas aparecen como No Actuales (TMU — True Mileage Unknown), lo que significa que las millas reales son desconocidas. Esto ocurre cuando el odómetro pudo haber sido alterado o el vehículo sufrió un daño importante que impide comprobar el millaje real.',
      'Exentas': 'Las millas aparecen como Exentas (Exempt), lo que significa que legalmente no se puede certificar que el número del tablero sea el real. Ocurre generalmente porque al momento del accidente el vehículo quedó sin batería, el tablero se dañó, o la aseguradora no pudo encenderlo para verificar. No implica necesariamente fraude — muchas veces el número del tablero es cercano al real, pero por protección legal se procesan como Exento. Recomendamos revisar el Carfax para ver las millas del último servicio registrado.'
    };
    const milesWarning = milesStatusMap[milesStatus] || '';

    // Salvage warning (solo para Clean)
    const isTitleClean = titleType === 'Clean';
    const hasHail = damageList.includes('Granizo');
    const salvageTriggers = ['Inundación/Agua', 'Vandalismo', 'Fuego'];
    const hasSalvageTrigger = damageList.some(d => salvageTriggers.includes(d));
    let salvageWarning = '';
    if (isTitleClean) {
      if (hasHail && !hasSalvageTrigger) {
        salvageWarning = 'Daño por granizo suele recibir automáticamente un título salvage al momento de registrarse. Sin embargo, en Texas normalmente conserva un título clean. Aun así, recomendamos contactar al DMV para confirmar si al momento de registrar el vehículo mantendría el título clean o podría cambiar a salvage.';
      } else if (hasHail && hasSalvageTrigger) {
        const extra = damageList.filter(d => salvageTriggers.includes(d)).join(', ');
        salvageWarning = `Dado que presenta granizo y ${extra}, existe una alta probabilidad de que el título cambie a salvage al registrarse dependiendo del estado. En Texas el granizo normalmente conserva título clean, pero los daños adicionales pueden cambiar esto. Recomendamos contactar al DMV antes de adquirirlo.`;
      } else if (hasSalvageTrigger) {
        const triggerNames = damageList.filter(d => salvageTriggers.includes(d)).join(', ');
        salvageWarning = `Dado que presenta ${triggerNames}, existe la posibilidad de que al registrar el vehículo el título cambie a salvage dependiendo del estado. Recomendamos contactar al DMV local para confirmar antes de adquirirlo.`;
      }
    }

    // Destruction
    const isDestruction = titleType === 'Certificate of Destruction / Junk';
    const destructionWarning = isDestruction
      ? 'Este vehículo posee un título Certificate of Destruction (Junk), lo que significa que JAMÁS podrá circular legalmente en las carreteras de Estados Unidos. Solo puede utilizarse para chatarra o venta de piezas.'
      : '';

    // Buy Now / Reserve
    const buyNowText = buyNow ? `El vehículo tiene un precio de compra inmediata (Buy Now) de $${buyNow}, ese es el precio mínimo que acepta el vendedor para cerrar la venta de inmediato.` : '';
    const reserveText = reservePrice ? `Tiene precio de reserva de $${reservePrice}.` : '';

    // Construir bloques adicionales como texto limpio
    const extraBlocks = [
      tituloAusente ? `En cuanto al título: Copart no posee el título actualmente. Le da al vendedor 30 días hábiles para que sea enviado a la yarda y luego ellos deben enviárnoslo a FL.` : '',
      milesWarning,
      salvageWarning,
      destructionWarning,
      copartGo ? 'Este vehículo está listado como CopartGO, lo que significa que fue publicado directamente por el vendedor usando la app móvil de Copart. El informe de condición lo completó el propio vendedor con respuestas de Sí/No y NO representa la opinión de Copart, quien no inspeccionó el vehículo ni se hace responsable de la exactitud del informe.' : '',
      externalLot ? 'Este es un Lote Externo: el vehículo NO se encuentra físicamente en una ubicación de Copart. Está en una ubicación designada para previsualizar y retirar indicada en el lote.' : '',
      fechaFuturo ? 'Es posible que Copart haya realizado un cambio reciente en la fecha de subasta. Actualmente, en nuestra plataforma puede aparecer una fecha estimada, pero si en Copart el lote figura como "Future" o "Upcoming Lot", significa que la subasta aún no tiene una fecha confirmada, generalmente porque están pendientes documentos o el título del vehículo. Le recomendamos verificar directamente en Copart. Una vez que la documentación esté completa, se asignará una fecha de subasta oficial y el lote estará disponible para ofertar.' : '',
      ...lightsLines,
      noLightsText,
      mechText,
    ].filter(Boolean);

    const prompt = `Eres un broker experto de subastas de vehículos salvage (Copart, IAAI, Manheim). Redacta un análisis profesional en español para WhatsApp. Texto plano, sin markdown, sin asteriscos, sin guiones al inicio, sin emojis. Varía el vocabulario en cada análisis.

REGLAS:
- El título es "${titleType}". Si es Clean: NO fue declarado pérdida total. Si es Salvage: el daño fue suficientemente severo para que la aseguradora lo declarara pérdida total. NUNCA confundas uno con el otro.
- Los daños son REALES y CONFIRMADOS. Afírmalos con seguridad.
- NO repitas información que ya mencionaste en un párrafo anterior.
- Cada bloque de información debe ir en su propio párrafo separado.
- NO agregues frases genéricas como "este vehículo está listo para inspección" o similares.

Estructura del análisis (cada bloque = un párrafo, omite los que estén vacíos):

PÁRRAFO 1: ${lot} - ${year} ${make.toUpperCase()} ${model.toUpperCase()}
Explica el título "${titleType}" en ${auction} (sin repetir en otros párrafos), menciona los daños "${damageTextClean}" afirmándolos con confianza, millas ${miles} (${milesStatus}), estado general breve.

${extraBlocks.map((block, i) => `PÁRRAFO ${i + 2}: ${block}`).join('\n\n')}

PÁRRAFO FINAL ANTES DE OFERTA: ${observations ? `Integra estas observaciones del broker de forma natural sin repetir lo ya dicho: ${observations}` : '(omitir si no hay observaciones)'}

Ofertaría entre $${offerMin} a $${offerMax}
${buyNowText}
${reserveText}

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
        max_tokens: 1200,
        temperature: 0.7
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(500).json({ error: data?.error?.message || 'Error de Groq' });
    const text = data?.choices?.[0]?.message?.content || '';
    return res.status(200).json({ result: text.trim() });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
