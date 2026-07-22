import crypto from 'node:crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { mode, fields } = req.body;

  // ---- MODO NHTSA (recalls, quejas y ratings) ----
  // Se hace del lado del servidor porque api.nhtsa.gov no garantiza CORS.
  // Todos los endpoints son gratuitos y no requieren API key.
  if (mode === 'nhtsa') {
    const { make, model, year } = req.body;
    if (!make || !model || !year) {
      return res.status(400).json({ error: 'Faltan make, model o year' });
    }
    const q = `make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`;

    // Timeout defensivo: NHTSA a veces tarda
    const grab = async (url, ms = 9000) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
      finally { clearTimeout(t); }
    };

    try {
      const [recallsJson, complaintsJson, variantsJson] = await Promise.all([
        grab(`https://api.nhtsa.gov/recalls/recallsByVehicle?${q}`),
        grab(`https://api.nhtsa.gov/complaints/complaintsByVehicle?${q}`),
        grab(`https://api.nhtsa.gov/SafetyRatings/modelyear/${encodeURIComponent(year)}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(model)}`)
      ]);

      // --- RECALLS ---
      const recalls = (recallsJson?.results || []).map(r => ({
        campaign: r.NHTSACampaignNumber || '',
        component: r.Component || '',
        summary: r.Summary || '',
        consequence: r.Consequence || '',
        remedy: r.Remedy || '',
        manufacturer: r.Manufacturer || '',
        date: r.ReportReceivedDate || '',
        parkIt: !!r.parkIt,
        parkOutside: !!r.parkOutSide
      }));

      // --- QUEJAS ---
      const rawComplaints = complaintsJson?.results || [];
      const byComponent = {};
      let crashes = 0, fires = 0, injuries = 0, deaths = 0;
      rawComplaints.forEach(c => {
        String(c.components || 'OTROS').split(',').forEach(comp => {
          const k = comp.trim();
          if (k) byComponent[k] = (byComponent[k] || 0) + 1;
        });
        if (c.crash) crashes++;
        if (c.fire) fires++;
        injuries += Number(c.numberOfInjuries) || 0;
        deaths += Number(c.numberOfDeaths) || 0;
      });
      const complaints = {
        total: rawComplaints.length,
        crashes, fires, injuries, deaths,
        topComponents: Object.entries(byComponent).sort((a, b) => b[1] - a[1]).slice(0, 8),
        items: rawComplaints.slice(0, 25).map(c => ({
          odi: c.odiNumber,
          components: c.components || '',
          summary: (c.summary || '').substring(0, 700),
          date: c.dateOfIncident || c.dateComplaintFiled || '',
          crash: !!c.crash,
          fire: !!c.fire,
          injuries: Number(c.numberOfInjuries) || 0,
          deaths: Number(c.numberOfDeaths) || 0
        }))
      };

      // --- RATINGS NCAP (dos pasos) ---
      let ratings = [];
      const variants = (variantsJson?.Results || []).slice(0, 4);
      if (variants.length) {
        const detail = await Promise.all(
          variants.map(v => grab(`https://api.nhtsa.gov/SafetyRatings/VehicleId/${v.VehicleId}`))
        );
        ratings = detail.map((d, i) => {
          const r = d?.Results?.[0];
          if (!r) return null;
          return {
            description: r.VehicleDescription || variants[i].VehicleDescription || '',
            overall: r.OverallRating || '',
            front: r.OverallFrontCrashRating || '',
            side: r.OverallSideCrashRating || '',
            rollover: r.RolloverRating || ''
          };
        }).filter(Boolean);
      }

      return res.status(200).json({ recalls, complaints, ratings });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ---- MODO AUTENTICACIÓN DE ADMINISTRADOR ----
  // El PIN vive en una variable de entorno de Vercel, NUNCA en el código del
  // navegador. Así un compañero no puede leerlo viendo el código fuente.
  if (mode === 'admin-auth') {
    const ADMIN_PIN = process.env.ADMIN_PIN;
    if (!ADMIN_PIN) return res.status(500).json({ ok: false, error: 'PIN de administrador no configurado en el servidor' });
    const pin = String(req.body?.pin || '');
    // Comparación de tiempo constante (evita adivinar el PIN midiendo demoras)
    const a = crypto.createHash('sha256').update(pin).digest();
    const b = crypto.createHash('sha256').update(String(ADMIN_PIN)).digest();
    const ok = crypto.timingSafeEqual(a, b);
    if (!ok) {
      // Pequeña demora para frenar intentos automáticos
      await new Promise(r => setTimeout(r, 700));
      return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
    }
    const token = crypto.createHash('sha256').update('mapa-admin:' + ADMIN_PIN).digest('hex').slice(0, 32);
    return res.status(200).json({ ok: true, token });
  }

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'API key no configurada' });

  // ---- MODO CARFAX ----
  if (mode === 'carfax') {
    const carfaxText = req.body.carfaxText || '';
    if (!carfaxText.trim()) return res.status(400).json({ error: 'Sin texto del Carfax' });
    try {
      const carfaxPrompt = `Eres un experto en análisis de reportes Carfax de vehículos de subasta. A continuación tienes el texto extraído de un reporte Carfax. Analízalo a fondo y genera un resumen profesional y COMPLETO en español para enviarle a un cliente. Texto plano, sin markdown, sin asteriscos, sin emojis.

Incluye SOLO lo que realmente aparezca en el reporte, en este orden:

1. TIPO DE TÍTULO: indica qué tipo de título reporta el Carfax (Clean, Salvage, Junk, Certificate of Destruction, Rebuilt, etc.) atribuyéndolo siempre al reporte ("el Carfax indica..."). Explica brevemente qué significa ese título. NO digas que fue reparado ni nada que el reporte no confirme.

2. TOTAL LOSS: SOLO si el reporte menciona explícitamente un "Total Loss" (pérdida total), inclúyelo con su fecha. Si el título del reporte es Clean pero hay un Total Loss registrado, advierte que el título podría cambiar a salvage al registrarse dependiendo del estado. Si el título YA es Salvage/Junk, NO digas que "podría pasar a salvage" (ya lo es, sería contradictorio) — en ese caso solo menciona el total loss como el evento que originó ese título si el reporte lo respalda. Si NO hay ningún total loss en el reporte, NO escribas ningún párrafo sobre pérdida total, omítelo por completo.

3. DUEÑOS ANTERIORES: cuántos dueños ha tenido.

4. ACCIDENTES: todos los accidentes o daños reportados con fechas si aparecen.

5. MILLAS / ODÓMETRO: registro de millas, y si hay alertas de rollback, inconsistencias o "not actual mileage". Si no hay alertas, dilo brevemente.

6. HISTORIAL DE SERVICIOS: mantenimientos o servicios relevantes.

7. USO DEL VEHÍCULO: personal, alquiler, flota, comercial, etc.

8. ALERTAS: recompras (lemon/buyback), daños por inundación, granizo, robo recuperado, recalls, o cualquier problema serio.

Termina con un punto de vista honesto y profesional sobre lo que refleja el reporte en general, coherente con todo lo anterior.

REGLAS CRÍTICAS:
- Solo usa información que esté REALMENTE en el texto. NO inventes nada. Si algo no aparece, omítelo por completo — no escribas párrafos diciendo "no hay registros de X".
- El resumen debe ser LÓGICO y COHERENTE de principio a fin: nunca digas algo en un párrafo que contradiga otro.
- No digas "ha sido reparado" ni supongas hechos que el reporte no confirma.
- No resumas en exceso: la información importante (título, total loss si existe, accidentes, millas) debe quedar completa y clara.
- NO menciones que "el Carfax no reporta daños mecánicos" dentro del cuerpo del resumen; esa frase se agrega automáticamente al final una sola vez, no la incluyas tú.

Texto del Carfax:
${carfaxText.substring(0, 14000)}`;

      const cRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: carfaxPrompt }],
          max_tokens: 2000,
          temperature: 0.4
        })
      });
      const cData = await cRes.json();
      if (!cRes.ok) return res.status(500).json({ error: cData?.error?.message || 'Error de Groq' });
      let cText = (cData?.choices?.[0]?.message?.content || '').trim();
      cText = cText.replace(/^[\s\-–—•*>]+/, '').trim();
      // Quitar cualquier mención duplicada del disclaimer que la IA haya puesto
      cText = cText.replace(/\.?\s*(Recuerde que\s+)?El Carfax no reporta daños mecánicos ni ocultos\.?/gi, '').trim();
      // Agregar el disclaimer una sola vez al final
      cText += '\n\nRecuerde que el Carfax no reporta daños mecánicos ni ocultos.';
      return res.status(200).json({ result: cText });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const { lot, year, make, model, vin, titleType, auction, miles, milesStatus,
            damages, dashLights, dashCustom, observations, mechanicalStatus,
            offerMin, offerMax, buyNow, reservePrice, offerNotes, copartGo, externalLot, tituloAusente, fechaFuturo, excelente, impecable, esMoto,
            vinContext, recallsText, lotRaw } = fields;

    const REPORT_LINK = 'https://t.me/reporteexpressbot';

    // ---- DAÑOS ----
    const damageListRaw = Array.isArray(damages) && damages.length > 0 ? damages : [];
    // "Damage History" no es un daño actual, es un antecedente: se maneja aparte
    const hasDamageHistory = damageListRaw.includes('Damage History');
    const damageList = damageListRaw.filter(d => d !== 'Damage History');
    // Traducción a lenguaje natural para el análisis
    const damageDisplay = {
      'All Over': 'daños generalizados en varias áreas del vehículo',
      'Minor Dent/Scratches': 'abolladuras y rayones menores',
      'Normal Wear': 'desgaste normal por uso',
      'Undercarriage': 'daño en los bajos (undercarriage)'
    };
    const damageClean = damageList.map(d => damageDisplay[d] || d.toLowerCase()).join(', ');
    const damageHistoryVariants = [
      'La subasta indica Damage History, lo que significa que el vehículo tiene un historial de daños o reclamaciones anteriores registrado en bases de datos. No corresponde al daño actual, sino a un antecedente del vehículo.',
      'El lote figura con Damage History: existe un historial de daños o reclamaciones previas registrado en bases de datos. Esto no se refiere al daño actual del vehículo, sino a un antecedente suyo.',
      'Aparece marcado como Damage History, es decir, el vehículo cuenta con antecedentes de daños o reclamaciones registrados en bases de datos. No corresponde al daño actual, sino a su historial.'
    ];
    const damageHistoryText = hasDamageHistory
      ? damageHistoryVariants[Math.floor(Math.random() * damageHistoryVariants.length)]
      : '';

    // ---- ESTADO MECÁNICO ----
    const mechMap = {
      'no-enciende': 'El vehículo no enciende.',
      'solo-enciende': `${auction} verificó que el motor enciende, sin embargo no se confirma si el vehículo rueda.`,
      'enciende-no-rueda': `${auction} verificó que el motor enciende, sin embargo el vehículo no rueda, lo que podría indicar algún tipo de falla mecánica como transmisión u otro problema relacionado.`,
      'enciende-rueda': `${auction} verificó que el motor enciende y la transmisión engrana.`
    };
    const mechText = mechMap[mechanicalStatus] || '';

    // ---- LUCES ----
    const lightsMap = {
      'check-engine': 'Presenta la luz de check engine encendida, lo que podría indicar algún tipo de falla mecánica o electrónica.',
      'airbag': 'Presenta la luz de airbag/SRS encendida, lo que podría indicar detonación de airbags o falla en el sistema de seguridad.',
      'transmission': 'Presenta la luz de transmisión encendida, lo que podría indicar algún tipo de falla en la caja automática.',
      'abs': 'Presenta la luz de ABS encendida, lo que podría indicar algún tipo de falla en el sistema de frenos antibloqueo.',
      'battery': 'Presenta la luz de batería encendida, lo que podría indicar falla en el alternador, batería o sistema eléctrico.',
      'oil': 'Presenta la luz de aceite encendida, lo que podría indicar baja presión de aceite o falla en el sistema de lubricación.',
      'temperature': 'Presenta la luz de temperatura encendida, lo que podría indicar sobrecalentamiento del motor.',
      'multiple': 'Presenta múltiples luces del tablero encendidas, lo que podría indicar algún tipo de daño eléctrico o falla mecánica en el vehículo.',
      'custom': dashCustom && dashCustom.trim()
        ? `Presenta ${dashCustom.trim()} encendido, lo que podría indicar algún tipo de falla mecánica o electrónica.`
        : 'Presenta otras luces de advertencia encendidas en el tablero, lo que podría indicar algún tipo de falla mecánica o electrónica.'
    };
    let lightsArray = Array.isArray(dashLights) ? dashLights : (dashLights && dashLights !== 'none' ? [dashLights] : []);
    // Las motocicletas no tienen airbag: filtrar por seguridad
    if (esMoto) lightsArray = lightsArray.filter(l => l !== 'airbag');
    const lightsLines = lightsArray.map(l => lightsMap[l] || '').filter(Boolean);
    const lightsBlock = lightsLines.length > 0
      ? lightsLines.join(' ')
      : (esMoto
          ? 'No presenta luces de advertencia encendidas en el tablero.'
          : 'No presenta luces de motor ni airbag encendidas en el tablero.');

    // ---- MILLAS ----
    const milesMap = {
      'No actuales (TMU)': 'Las millas aparecen como No Actuales (TMU — True Mileage Unknown), lo que significa que las millas reales son desconocidas. Esto puede deberse a varias razones: que el odómetro haya sido modificado ilegalmente, que el vehículo sufriera un daño importante que impide comprobar el millaje, o una falla en el tablero. Considérelo al momento de evaluar el vehículo.',
      'Exentas': 'Las millas aparecen como Exentas (Exempt), lo que significa que legalmente no se puede certificar que el número del tablero sea el real. Generalmente ocurre porque al momento del accidente el vehículo quedó sin batería, el tablero se dañó, o la aseguradora no pudo encenderlo para verificar. No implica necesariamente fraude; muchas veces el número del tablero es cercano al real, pero por protección legal se procesa como Exento. Recomendamos revisar el Carfax para ver las millas del último servicio registrado.'
    };
    const milesWarning = milesMap[milesStatus] || '';

    // ---- EVALUACIÓN DEL MILLAJE ----
    // Determinista (aritmética): compara las millas contra el promedio anual
    // esperado según el año del vehículo. Solo aplica si las millas son ACTUALES;
    // con TMU o Exentas el número no es confiable y ya se advierte aparte.
    const fmtNum = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    let milesEvalText = '';
    const milesNum = parseInt(String(miles || '').replace(/[^\d]/g, ''), 10);
    const yearNum = parseInt(String(year || '').replace(/[^\d]/g, ''), 10);
    const currentYear = new Date().getFullYear();
    if (milesStatus === 'Actuales' && milesNum > 0 && yearNum >= 1980 && yearNum <= currentYear + 1) {
      // Promedio anual de referencia en EE.UU.: autos ~13,500 mi; motos mucho menos
      const promedioAnual = esMoto ? 3000 : 13500;
      // Un modelo del año actual o del siguiente cuenta como 1 año de uso
      const edad = Math.max(1, currentYear - yearNum);
      const esperado = promedioAnual * edad;
      const ratio = milesNum / esperado;
      const millasFmt = fmtNum(milesNum);
      const esperadoFmt = fmtNum(esperado);
      const unidadDe = esMoto ? 'de la motocicleta' : 'del vehículo';
      const unidadArt = esMoto ? 'una motocicleta' : 'un vehículo';
      const causaUso = esMoto
        ? 'Un uso tan intensivo suele venir de recorridos largos o trabajo de mensajería, e implica mayor desgaste en motor, transmisión y suspensión.'
        : 'Un uso tan intensivo suele provenir de flotas, transporte o recorridos largos, e implica mayor desgaste en motor, transmisión y suspensión.';

      if (ratio >= 1.8) {
        milesEvalText = `Sobre el millaje: ${millasFmt} millas es una cifra muy elevada para ${unidadArt} ${yearNum}, ya que el promedio esperado para su año rondaría las ${esperadoFmt} millas. ${causaUso} Tómelo en cuenta al evaluar la unidad.`;
      } else if (ratio >= 1.3) {
        milesEvalText = `Sobre el millaje: ${millasFmt} millas está por encima del promedio para ${unidadArt} ${yearNum}, cuyo estimado habitual sería de unas ${esperadoFmt} millas. No es alarmante, pero conviene considerar el desgaste adicional acumulado.`;
      } else if (ratio <= 0.6) {
        milesEvalText = `Sobre el millaje: ${millasFmt} millas está por debajo del promedio para ${unidadArt} ${yearNum} (lo esperado rondaría las ${esperadoFmt} millas), lo cual es un punto a favor ${unidadDe}.`;
      } else {
        milesEvalText = `Sobre el millaje: ${millasFmt} millas es una cifra acorde para ${unidadArt} ${yearNum}, en línea con el promedio esperado para su año.`;
      }
    }

    // ---- SALVAGE WARNING (solo Clean) ----
    const isTitleClean = titleType === 'Clean';
    const hasHail = damageList.includes('Granizo');
    const salvageTriggers = ['Inundación/Agua', 'Vandalismo', 'Fuego'];
    const otherTriggers = damageList.filter(d => salvageTriggers.includes(d));
    const hasSalvageTrigger = otherTriggers.length > 0;
    let salvageWarning = '';
    if (isTitleClean) {
      if (hasHail && !hasSalvageTrigger) {
        const granizoVariants = [
          'El daño por granizo suele recibir automáticamente un título salvage al momento de registrarse en la mayoría de los estados. Texas es la excepción: por ley, el daño exclusivamente por granizo no convierte el vehículo en salvage y conserva su título clean. Aun así, recomendamos contactar al DMV del estado donde se registrará para confirmar cómo quedaría el título.',
          'Tenga en cuenta que en muchos estados el daño por granizo hace que el título pase a salvage durante el registro. Texas es una excepción confirmada por ley: si el daño es exclusivamente por granizo, el vehículo mantiene su título clean. Le sugerimos verificar con el DMV correspondiente antes de adquirirlo.',
          'Es importante saber que el daño por granizo puede provocar un cambio de título a salvage al registrar el vehículo, dependiendo del estado. En Texas, la ley excluye el daño exclusivo por granizo de la definición de vehículo salvage, por lo que normalmente conserva el título clean. Recomendamos confirmar con el DMV cómo quedaría el título en su caso.'
        ];
        salvageWarning = granizoVariants[Math.floor(Math.random() * granizoVariants.length)];
      } else if (hasHail && hasSalvageTrigger) {
        salvageWarning = `Dado que presenta granizo y ${otherTriggers.join(', ').toLowerCase()}, existe una alta probabilidad de que el título cambie a salvage al momento de registrarse, dependiendo del estado. En Texas el daño exclusivo por granizo conserva título clean por ley, pero los daños adicionales pueden cambiar esto. Recomendamos contactar al DMV para confirmarlo antes de adquirirlo.`;
      } else if (hasSalvageTrigger) {
        salvageWarning = `Dado que presenta ${otherTriggers.join(', ').toLowerCase()}, existe la posibilidad de que al momento de registrar el vehículo el título cambie a salvage, dependiendo del estado donde sea registrado. Cada estado tiene sus propias reglas y umbrales de daño (entre el 60% y el 100% del valor del vehículo). Recomendamos contactar al DMV local para confirmar esto antes de adquirirlo.`;
      }
    }

    // ---- DESTRUCTION ----
    const isDestruction = titleType === 'Certificate of Destruction / Junk';
    const destructionWarning = isDestruction
      ? 'Este vehículo posee un título Certificate of Destruction (Junk), lo que significa que JAMÁS podrá circular legalmente en las carreteras de Estados Unidos. Solo puede utilizarse para chatarra o venta de piezas.'
      : '';

    // ---- TOGGLES ----
    const tituloAusenteText = tituloAusente
      ? `En cuanto al título: ${auction} no posee el título actualmente. Le da al vendedor 30 días hábiles para que sea enviado a la yarda y luego ellos deben enviárnoslo a FL.`
      : '';
    // Bill of Sale: texto exacto aprobado por el equipo. Determinista para garantizar
    // que el trámite legal salga siempre igual y no lo reescriba el modelo.
    const esBillOfSale = titleType === 'Bill of Sale';
    const billOfSaleText = esBillOfSale
      ? 'La subasta no posee el título del vehículo y entrega un Bill of Sale. Con ese documento el cliente deberá tramitar un título nuevo en el DMV de su estado.'
      : '';
    const copartGoText = copartGo
      ? 'Este vehículo está listado como CopartGO, lo que significa que fue publicado directamente por el vendedor usando la app móvil de Copart. El informe de condición lo completó el propio vendedor con respuestas de Sí/No y no representa la opinión de Copart, quien no inspeccionó el vehículo ni se hace responsable de la exactitud del informe.'
      : '';
    const externalLotText = externalLot
      ? `Este es un Lote Externo: el vehículo no se encuentra físicamente en una ubicación de ${auction}. Está en una ubicación designada para previsualizar y retirar indicada en el lote.`
      : '';
    const fechaFuturoText = fechaFuturo
      ? `Es posible que ${auction} haya realizado un cambio reciente en la fecha de subasta. Actualmente en nuestra plataforma puede aparecer una fecha estimada, pero si en ${auction} el lote figura como "Future" o "Upcoming Lot", significa que la subasta aún no tiene una fecha confirmada, generalmente porque están pendientes documentos o el título del vehículo. Le recomendamos verificar directamente en ${auction}. Una vez que la documentación esté completa, se asignará una fecha de subasta oficial y el lote estará disponible para ofertar.`
      : '';

    // Variantes de "excelente estado": si hay daños marcados, usa versiones que no contradigan
    const excelenteVariantsSinDanos = [
      'El vehículo se observa en excelente estado, sin daños estéticos apreciables. Es una unidad impecable, muy bien cuidada y con una presentación sobresaliente.',
      'Se trata de un vehículo en condiciones excepcionales, sin golpes ni daños visibles en la carrocería. Una excelente oportunidad por su estado prácticamente impecable.',
      'El vehículo luce en muy buen estado general, sin daños estéticos notables. Es una unidad limpia, bien mantenida y con una apariencia excelente.',
      'Excelente unidad, se aprecia en óptimas condiciones tanto estéticas como generales, sin daños visibles. Un vehículo muy bien conservado.'
    ];
    const excelenteVariantsConDanos = [
      'Más allá del daño mencionado, el vehículo se observa en excelente estado general. Es una unidad bien cuidada y con muy buena presentación.',
      'Fuera del daño indicado, el vehículo luce en condiciones excepcionales, bien mantenido y con una apariencia sobresaliente.',
      'Aparte del daño señalado, se aprecia una unidad en muy buen estado, limpia y bien conservada.'
    ];
    const excelentePool = damageList.length > 0 ? excelenteVariantsConDanos : excelenteVariantsSinDanos;
    const excelenteText = excelente
      ? excelentePool[Math.floor(Math.random() * excelentePool.length)]
      : '';

    // "Impecable estado": enfoque en que en las fotos no se aprecian daños estéticos
    const impecableVariantsSinDanos = [
      'El vehículo en las fotos se ve impecablemente bien, no se aprecian daños estéticos. Excelente opción de compra.',
      'En las fotos el vehículo luce impecable, sin daños estéticos visibles. Una muy buena opción de compra.',
      'Por las fotos, el vehículo se observa impecable y sin daños estéticos apreciables. Excelente oportunidad de compra.'
    ];
    const impecableVariantsConDanos = [
      'Fuera del daño indicado, en las fotos el vehículo se ve impecablemente bien, sin otros daños estéticos apreciables. Excelente opción de compra.',
      'Más allá del daño mencionado, por las fotos el vehículo luce impecable, sin otros daños estéticos visibles. Muy buena opción de compra.'
    ];
    const impecablePool = damageList.length > 0 ? impecableVariantsConDanos : impecableVariantsSinDanos;
    const impecableText = impecable
      ? impecablePool[Math.floor(Math.random() * impecablePool.length)]
      : '';

    // ---- OFERTA (números con formato de miles) ----
    const fmt = n => {
      const num = parseFloat(String(n).replace(/,/g, ''));
      return isNaN(num) ? n : num.toLocaleString('en-US');
    };
    const offerVariants = (offerMin && offerMax) ? [
      `Ofertaría entre $${fmt(offerMin)} a $${fmt(offerMax)}`,
      `Podríamos ofertar entre $${fmt(offerMin)} a $${fmt(offerMax)}`,
      `Mi recomendación sería ofertar entre $${fmt(offerMin)} a $${fmt(offerMax)}`,
      `Sugiero pujar entre $${fmt(offerMin)} a $${fmt(offerMax)}`,
      `Podríamos pujar entre $${fmt(offerMin)} a $${fmt(offerMax)}`,
      `Recomendaría ofertar en un rango de $${fmt(offerMin)} a $${fmt(offerMax)}`
    ] : [];
    const offerText = offerVariants.length ? offerVariants[Math.floor(Math.random() * offerVariants.length)] : '';
    const buyNowText = buyNow ? `El vehículo tiene un precio de compra inmediata (Buy Now) de $${fmt(buyNow)}, ese es el precio mínimo que acepta el vendedor para cerrar la venta de inmediato.` : '';
    const reserveText = reservePrice ? `Tiene un precio de reserva de $${fmt(reservePrice)}.` : '';

    // Solo la primera línea la genera la IA para dar variedad; el resto es fijo y controlado.
    const titleExplain = {
      'Clean': 'no fue declarado pérdida total por la aseguradora',
      'Salvage': 'el daño fue lo suficientemente severo para que la aseguradora lo declarara pérdida total',
      'Rebuilt': 'fue reconstruido tras haber tenido un título salvage y aprobó la inspección estatal',
      'Bill of Sale': 'la subasta no posee el título y entrega un Bill of Sale; el cliente debe tramitar un título nuevo en el DMV, usualmente por la vía del bonded title',
      'Parts Only': 'solo puede usarse para piezas, no puede registrarse para circular',
      'Certificate of Destruction / Junk': 'no puede circular legalmente, solo sirve para chatarra o piezas'
    };

    const prompt = `Eres un broker de subastas de vehículos. Redacta SOLO el primer párrafo de un análisis, en español, en una a dos oraciones. Texto plano, sin markdown, sin emojis.
${esMoto ? '\nIMPORTANTE: Este lote es una MOTOCICLETA. Refiérete a ella como motocicleta o moto, NUNCA como "vehículo" genérico de cuatro ruedas. NUNCA menciones airbags, transmisión automática, ni nada que las motos no tengan.\n' : ''}

IMPORTANTE: Varía SIEMPRE la estructura y el vocabulario. Cada vez que generes este párrafo debe sonar diferente al anterior — cambia el orden de las ideas, usa sinónimos, varía cómo introduces el título y los daños. Nunca repitas la misma redacción.

Datos:
- Título: ${titleType}${esBillOfSale ? '' : ` (significa: ${titleExplain[titleType] || ''})`}
- Daños: ${damageClean || 'ninguno especificado'}
${miles ? `- Millas: ${miles} ${(milesStatus||'').toLowerCase()}` : '- Millas: no especificadas (NO las menciones)'}
${vinContext && vinContext.trim() ? `
FICHA TÉCNICA OFICIAL (decodificada del VIN en la base de datos de NHTSA):
${vinContext.trim()}

CÓMO USAR LA FICHA TÉCNICA: es solo una REFERENCIA DE EXACTITUD, no contenido para agregar. NO la enumeres, NO listes el motor, la tracción, la transmisión ni la planta de fabricación, y NO alargues el párrafo por ella. Su única función es que, si mencionas algo del vehículo de forma natural, no lo contradigas ni lo inventes. Si la ficha dice que es una motocicleta, trátalo como motocicleta. El párrafo debe quedar igual de corto que sin esta ficha.
` : ''}
Reglas:
${esBillOfSale ? `- CASO ESPECIAL (Bill of Sale): NO menciones el título, NO uses la palabra "Bill of Sale" y NO expliques ningún trámite. La explicación del Bill of Sale se agrega automáticamente por separado. Escribe SOLO los daños${miles ? ' y las millas' : ''} en una frase natural. Si no hay daños${miles ? '' : ' ni millas'} que mencionar, responde con una cadena vacía.` : `- Empieza indicando el título sin afirmarlo con certeza absoluta, atribuyéndolo a la subasta. VARÍA la forma de decirlo cada vez, usa diferentes opciones como: "La subasta indica título ${titleType}", "El lote figura con título ${titleType}", "De acuerdo a la subasta, el título es ${titleType}", "${auction} reporta título ${titleType}", "El vehículo aparece listado con título ${titleType}", "Registrado en la subasta como título ${titleType}". NUNCA uses siempre la misma frase, NUNCA digas "El título de ${titleType}".
- Al explicar el significado del título usa el verbo REFERIR: "refiere que...". PROHIBIDO usar "indica que", "significa que" o "quiere decir que" para explicar el significado del título.
- PROHIBIDO escribir "este título". Es la fórmula que más se repite y suena robótica. Para retomar el título antes del verbo, VARÍA en cada generación entre estas opciones: "dicho título", "esta clasificación", "dicha clasificación", "esta condición", "dicha categoría", o simplemente NO retomarlo y encadenar directo ("lo que según la subasta refiere que..."). Elige una distinta cada vez.
- Sí puedes atribuir a la subasta al explicar el significado, esa parte nos gusta: "lo que según la subasta, dicha clasificación refiere que...", "lo que de acuerdo a ${auction}, dicho título refiere que...". Para Salvage el sentido es: el vehículo habría sufrido un daño suficientemente severo para ser declarado pérdida total.
- Nunca afirmes el significado del título como un hecho propio: solo repetimos la información de la subasta, no la verificamos nosotros.`}
- Afirma los daños con seguridad, nunca digas "sugiere" o "podría tener daños".
- Menciona los daños tal como están escritos, de forma natural: si dice "daño trasero" escribe "daño trasero" (NO "daño en el trasero"), si dice "granizo" escribe "daño por granizo". Para varios: "daño frontal y lateral".
- NO inventes datos ni agregues frases de relleno como "es beneficioso al vender", "proporciona una visión clara", "es un factor importante a considerar", "ofrece un atractivo precio de compra", "sin otros daños reportados", "su historial no presenta registros" o "puede necesitar reparaciones". NUNCA hables de historial ni reportes previos, no tenemos esa información.
- Menciona las millas SOLO como dato numérico. NO opines si son altas, bajas, elevadas o acordes, NO las compares con el promedio ni con el año del vehículo: esa evaluación se agrega automáticamente por separado.
- NO menciones fecha de subasta, luces, ni nada que no esté en los datos.
- Devuelve SOLO ese párrafo, nada más.`;

    // Ambas llamadas a Groq en PARALELO para mayor velocidad
    const firstParagraphPromise = fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 1.0
      })
    });

    // La observación se mejora con IA. La detección de texto trivial (un número,
    // símbolos, sin palabras reales) se hace AQUÍ en código, no en el prompt:
    // pedírselo al modelo lo volvía conservador y devolvía el texto casi literal.
    const obsRaw = (observations || '').trim();
    // Trivial = no contiene ninguna palabra de 3+ letras (ej. "23", "-", "??")
    const obsEsTrivial = !/[a-záéíóúüñ]{3,}/i.test(obsRaw);
    const obsPromise = (obsRaw && !obsEsTrivial)
      ? fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: `Eres un broker profesional de subastas de vehículos. Reescribe la siguiente observación en español con redacción profesional y fluida, corrigiendo ortografía y acentos, manteniendo exactamente el mismo significado y sin inventar información nueva.

OBSERVACIÓN: "${obsRaw}"

Reglas:
- Devuelve SOLO la observación reescrita, sin comillas, sin preámbulo y sin explicar lo que hiciste.
- Debe sonar mejor redactada que el original, no una copia literal.
- Una o dos oraciones como máximo.
- Si el original expresa una posibilidad o sospecha, consérvala como tal (no la afirmes como un hecho).` }],
            max_tokens: 150,
            temperature: 0.6
          })
        })
      : Promise.resolve(null);

    const yaMencionado = [offerText, buyNowText, reserveText].filter(Boolean).join(' ');
    const offerNotesPromise = (offerNotes && offerNotes.trim())
      ? fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: `Eres un broker de subastas de vehículos (Copart, IAAI, Manheim). Mejora la redacción de esta nota sobre la oferta de un lote, en español, de forma profesional y breve.

NOTA DEL BROKER: "${offerNotes}"

${yaMencionado ? `INFORMACIÓN QUE YA SE MENCIONÓ ANTES (NO la repitas, ni repitas las cifras): "${yaMencionado}"` : ''}

REGLAS ESTRICTAS:
- Esto es una SUBASTA, no una negociación. Usa el vocabulario correcto: "pujar", "ofertar", "subastar", "oferta". NUNCA uses las palabras "negociar", "negociación", "margen de negociación" ni "regatear".
- NO repitas cifras ni información que ya se mencionó arriba. Complementa, no repitas.
- NO inventes datos ni cifras que no estén en la nota del broker.
- Debe fluir de forma natural como continuación de lo ya dicho.
- Máximo 1 a 2 oraciones.
- Devuelve SOLO el texto mejorado, sin comillas ni preámbulo.` }],
            max_tokens: 200,
            temperature: 0.5
          })
        })
      : Promise.resolve(null);

    const [groqRes, obsRes, offerNotesRes] = await Promise.all([firstParagraphPromise, obsPromise, offerNotesPromise]);

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(500).json({ error: data?.error?.message || 'Error de Groq' });
    let firstParagraph = (data?.choices?.[0]?.message?.content || '').trim();
    // Limpiar guiones, viñetas o caracteres sueltos al inicio
    firstParagraph = firstParagraph.replace(/^[\s\-–—•*>]+/, '').trim();

    // ---- RED DE SEGURIDAD DEL TÍTULO ----
    // A temperatura 1.0 el modelo recae en "este título indica que" aunque el prompt lo prohíba.
    // Se corrige aquí de forma determinista, SIN tocar la atribución a la subasta (esa nos gusta).
    const tituloRefVariants = ['dicho título', 'esta clasificación', 'dicha clasificación', 'esta condición', 'dicha categoría'];
    firstParagraph = firstParagraph
      // Verbo: "indica/significa/quiere decir que" -> "refiere que"
      .replace(/\b(?:indica|significa|quiere\s+decir)\s+que\b/gi, 'refiere que')
      // "este título" -> una variante distinta en cada llamada
      .replace(/\beste\s+t[ií]tulo\b/gi, () => tituloRefVariants[Math.floor(Math.random() * tituloRefVariants.length)])
      // Limpieza de espacios o comas que puedan quedar sueltos
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+,/g, ',')
      .replace(/,\s*,/g, ',')
      .trim();

    let obsText = '';
    if (obsEsTrivial) {
      // Texto trivial (un número, símbolos): se muestra tal cual, sin pasar por IA.
      obsText = obsRaw;
    } else if (obsRes) {
      const obsData = await obsRes.json();
      if (obsRes.ok) {
        obsText = (obsData?.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
        // Red de seguridad: si el modelo comenta en vez de reescribir, o falla,
        // usamos la observación original tal cual para no perder el dato.
        const metaObs = /(no hay (texto|nada)|nada que mejorar|no requiere|no se puede mejorar|no es necesario|solo un n[uú]mero|no aplica|aqu[ií] (est[aá]|tienes))/i.test(obsText);
        if (!obsText || metaObs) obsText = obsRaw;
      } else {
        obsText = obsRaw;
      }
    }

    let offerNotesText = '';
    if (offerNotesRes) {
      const onData = await offerNotesRes.json();
      if (offerNotesRes.ok) {
        offerNotesText = (onData?.choices?.[0]?.message?.content || '').trim()
          .replace(/^["']|["']$/g, '')
          .replace(/^[\s\-–—•*>]+/, '');
        // Red de seguridad: es una subasta, no una negociación
        offerNotesText = offerNotesText
          .replace(/margen de negociaci[oó]n/gi, 'margen para pujar')
          .replace(/negociaci[oó]n/gi, 'puja')
          .replace(/\bnegociarse\b/gi, 'pujarse')
          .replace(/\bnegociar\b/gi, 'pujar')
          .replace(/\bnegociando\b/gi, 'pujando')
          .replace(/\bregatear\b/gi, 'pujar');
      }
    }

    // ---- ENSAMBLAR EL TEXTO FINAL (controlado) ----
    const vehParts = [year, (make||'').toUpperCase(), (model||'').toUpperCase()].filter(Boolean).join(' ');
    // Encabezado: si el campo no traía el formato "lote - año marca modelo"
    // (el broker escribió un punto o texto libre), se respeta tal cual lo escribió.
    const header = [lot, vehParts].filter(Boolean).join(' - ') || (lotRaw || '').trim();

    const blocks = [
      billOfSaleText,
      firstParagraph,
      damageHistoryText,
      tituloAusenteText,
      milesWarning,
      milesEvalText,
      salvageWarning,
      destructionWarning,
      (recallsText && recallsText.trim() ? recallsText.trim() : ''),
      copartGoText,
      externalLotText,
      fechaFuturoText,
      excelenteText,
      impecableText,
      lightsBlock,
      mechText,
      obsText,
    ].filter(Boolean);

    const offerBlock = [offerText, buyNowText, reserveText, offerNotesText].filter(Boolean).join('\n');

    const footer = esMoto
      ? `VIN: ${vin}`
      : `VIN: ${vin}
Solicite su REPORTE aquí:
${REPORT_LINK}

Es siempre recomendable revisar el Reporte de Carfax para verificar el tipo de título, millas, servicios realizados, accidentes reportados, y propietarios anteriores.

CARFAX NO DA INFORMACIÓN DE DAÑOS MECÁNICOS NI OCULTOS`;

    let result = header + '\n' + blocks.join('\n\n');
    if (offerBlock) result += '\n\n' + offerBlock;
    result += '\n\n' + footer;

    // Eliminar líneas que sean solo un guion/viñeta suelto
    result = result
      .split('\n')
      .filter(line => !/^\s*[-–—•*]+\s*$/.test(line))
      .join('\n')
      .trim();

    return res.status(200).json({ result });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
