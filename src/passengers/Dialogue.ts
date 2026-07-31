/**
 * Loco Lift — passenger dialogue.
 *
 * A per-archetype line bank covering every `DialogueTrigger`, plus the director
 * that decides *when* someone gets to talk. Rules:
 *
 *  - Spanish is idiomatic Puerto Rican Spanish, correctly accented. Code-switching
 *    is real: Tato and K-Bo drop English words the way people actually do, Marla
 *    speaks English with the Spanish she's picked up this week.
 *  - Every line is the character reacting to *the situation*. No "Latin character"
 *    shorthand (ART_REFERENCE §7.5).
 *  - Nothing spams: each line has its own cooldown, there is a global minimum gap
 *    between utterances, and high-priority triggers can pre-empt low ones.
 *
 * The director owns no per-frame allocation: the bank is compiled once into
 * fixed arrays, candidate selection walks them by index, and the only object
 * created per line is the event payload the bus requires.
 */
import type { EventBus } from '../core/EventBus';
import type { RNG } from '../core/RNG';
import type { DialogueLine, DialogueTrigger, PassengerMood } from '../core/types';

/* ------------------------------------------------------------------ bank */

const L = (
  trigger: DialogueTrigger,
  text: string,
  cooldown = 25,
  mood?: PassengerMood,
): DialogueLine => ({ trigger, text, cooldown, mood });

/* --- Kique el Barrilero — bomba drummer, late to the bombazo -------------- */
const BOMBA_DRUMMER: readonly DialogueLine[] = [
  L('hail', '¡Taxi! ¡Ey, taxi! Tengo el barril y no tengo tiempo.', 30),
  L('hail', 'Mano, el bombazo empieza sin mí si no me montas.', 30),
  L('hail', '¡Aquí, aquí! El que carga barril no corre.', 30),

  L('pickup', 'Cuidado con el barril, que ese cuero tiene más años que tú.', 40),
  L('pickup', 'Arranca, que el corillo ya está calentando sin mí.', 40),
  L('pickup', 'Métele. Yo llevo el tiempo, tú lleva el carro.', 40),

  L('idle', 'El barril suena mejor cuando llega temprano.', 45),
  L('idle', 'Tú sabes que el piquete se lleva por dentro, ¿verdad?', 45),
  L('idle', 'Le voy a dedicar un repique a esta guagua tuya.', 45),
  L('idle', 'Mi abuelo tocaba en esta misma calle. Con el mismo barril.', 50),
  L('idle', 'Uno, dos... no, tú vas en tres. Deja eso.', 45),

  L('drift', '¡Eso fue un repique, mano!', 12),
  L('drift', '¡Ese cantazo iba en clave!', 12),
  L('drift', '¡Ahí, ahí! Eso es un seis corrido.', 12),

  L('jump', '¡Wepa! ¡Volamos en tiempo!', 12),
  L('jump', '¡El barril se me subió al pecho!', 12),

  L('nearMiss', '¡Ay, por poco le das al pana!', 10),
  L('nearMiss', 'Uf. Ese lo esquivaste en el uno.', 10),

  L('crash', '¡Acho! ¡El barril, el barril, cuida el barril!', 8),
  L('crash', 'Mano. Ese cuero no se consigue en cualquier sitio.', 8),

  L('boost', '¡Dale gas, que esto es bomba, no danza!', 14),
  L('boost', '¡Métele, que el tambor no espera!', 14),

  L('wrongWay', 'Mano, el salón queda pa\'l otro lado.', 16),
  L('wrongWay', 'Tú vas en contratiempo, y no del bueno.', 16),

  L('almostThere', 'Ya escucho los panderos. Métele.', 20),
  L('almostThere', 'Huele a alcapurria. Llegamos.', 20),

  L('dropoff', '¡Llegaste en tiempo! Quédate pa\'l bombazo, te guardo sitio.', 30),
  L('dropoff', 'Tremendo. Toma, y esta noche tú bailas aunque no quieras.', 30),

  L('perfect', '¡Brutal! Tú tienes swing pa\' esto, en serio.', 30),
  L('perfect', 'Ni un golpe fuera de tiempo. Eso es oficio.', 30),

  L('timeout', 'Nada, me voy caminando. El barril pesa menos que la espera.', 30),

  L('shortcut', '¿Por el callejón? Eso es tumbao.', 18),
  L('shortcut', 'Ese atajo lo usaba yo con la bicicleta.', 18),
];

/* --- Doña Yolanda — pastelería owner with a wedding cake ------------------ */
const BAKERY_OWNER: readonly DialogueLine[] = [
  L('hail', '¡Joven! Necesito llegar con este bizcocho entero. Entero, ¿me oye?', 30),
  L('hail', 'Aquí, mi amor. Y ayúdeme, que esto pesa.', 30),
  L('hail', '¿Está libre? Tengo una boda a la que llegarle.', 30),

  L('pickup', 'Tres pisos, buttercream y una novia que llora fácil. Maneje bonito.', 45),
  L('pickup', 'Si se cae este bizcocho, se cae mi negocio. No estoy exagerando.', 45),
  L('pickup', 'Despacito. Yo le pago igual, no hay prisa que valga un piso.', 45),

  L('idle', 'Vaya despacito en las curvas, mi amor.', 40),
  L('idle', 'Cuarenta años horneando y nunca he perdido un bizcocho. Nunca.', 50),
  L('idle', '¿Usted sabe lo que cuesta el fondant hoy en día?', 45),
  L('idle', 'La novia escogió guayaba. Buena muchacha.', 45),
  L('idle', 'Mi mamá abrió la panadería en el cincuenta y siete. Yo nací en la trastienda.', 55),

  L('drift', '¡Ay, no, no, no! ¡El bizcocho!', 8),
  L('drift', '¡Joven! ¡Que esto no es una pista!', 8),
  L('drift', '¡Las dos manos! ¡Las dos manos!', 8, 'terrified'),

  L('jump', '¡Santo cielo, volamos!', 8),
  L('jump', '¡Yo no firmé para esto!', 8),

  L('nearMiss', '¡Ese carro casi nos lleva!', 9),
  L('nearMiss', 'Ay. Ay. Respire usted, que yo no puedo.', 9),

  L('crash', '¡Ay bendito! Dígame que el piso de arriba aguantó.', 7),
  L('crash', '¡Eso me lo paga usted! ¡Eso me lo paga usted!', 7),

  L('boost', '¿Y ahora pa\' qué es esa velocidad? ¡Ya vamos bien!', 14),
  L('boost', 'Suelte eso. Suéltelo, se lo pido por favor.', 14),

  L('wrongWay', 'Mi amor, la boda no es por ahí.', 15),
  L('wrongWay', 'Usted se pasó la calle. Yo se lo dije.', 15),

  L('almostThere', 'Ya casi. Con calma, con calma.', 20),
  L('almostThere', 'Ya veo la capilla. No me lo dañe ahora.', 20),

  L('dropoff', 'Entero, sin una grieta. Gracias a Dios y a usted. Tenga, cómprese un cafecito.', 30),
  L('dropoff', 'Pase por la panadería el lunes. Le guardo pan de agua caliente.', 30),

  L('perfect', '¡Ni una grieta! Usted maneja como quien hornea: con cariño.', 30),
  L('perfect', 'Mire eso. Perfecto. Usted tiene buenas manos.', 30),

  L('timeout', 'Me voy en la guagua. Al menos la guagua frena.', 30),

  L('shortcut', '¿Por aquí? Bueno... usted sabrá lo que hace.', 18),
  L('shortcut', 'Por este callejón repartía mi papá. Está bien, está bien.', 18),
];

/* --- Marla — cruise guest with nine minutes ------------------------------ */
const CRUISE_GUEST: readonly DialogueLine[] = [
  L('hail', 'Taxi! Hola — hi — my ship leaves in nine minutes!', 30),
  L('hail', '¡Por favor! Please. Please. El muelle.', 30),
  L('hail', 'Are you free? ¿Libre? I think that\'s the word!', 30),

  L('pickup', 'Muelle, please, el muelle! My passport is on that boat!', 45),
  L('pickup', 'Okay. Okay. Nine minutes. We can do nine minutes, right?', 45),

  L('idle', 'Is nine minutes a lot here? It doesn\'t feel like a lot.', 45),
  L('idle', 'My husband said "we have time." My husband is wrong.', 50),
  L('idle', 'I bought seventeen magnets. I regret four of them.', 50),
  L('idle', 'These streets are gorgeous. I would enjoy them more later.', 45),
  L('idle', 'The lady at the café called me "mi amor." I loved that.', 50),

  L('drift', 'Okay! Okay. That was — ¡ay! — that was fine.', 10),
  L('drift', 'I felt that in my teeth!', 10),

  L('jump', 'WE ARE IN THE AIR. WE ARE IN THE AIR.', 9),
  L('jump', 'That is not a road! That was not a road!', 9),

  L('nearMiss', 'That van! That van was RIGHT there!', 9),
  L('nearMiss', 'Nope. Nope nope nope. Okay. Fine.', 9),

  L('crash', 'Is that normal? Please tell me that\'s normal.', 8),
  L('crash', 'My magnets! Half of them are under the seat!', 8),

  L('boost', 'Yes! Faster! ¡Rápido! That\'s the word, right?', 14),
  L('boost', 'Oh, there was MORE? There was more this whole time?', 14),

  L('wrongWay', 'That\'s — that\'s the wrong way. The water is behind us!', 15),
  L('wrongWay', 'I can see the ship. It is not in that direction.', 15),

  L('almostThere', 'I see it! ¡El barco! Don\'t stop, don\'t stop!', 18),
  L('almostThere', 'They\'re pulling the ramp. THEY\'RE PULLING THE RAMP.', 18),

  L('dropoff', 'You saved my vacation. Keep the change — keep all of it!', 30),
  L('dropoff', '¡Gracias! Gracias, gracias. I\'m telling everyone on deck about you.', 30),

  L('perfect', 'Best five minutes of the whole cruise. And I did the zip line!', 30),
  L('perfect', 'Do you do this for a living? Because you should. You do. Obviously.', 30),

  L('timeout', 'Forget it, I\'m running. In these shoes. Fantastic.', 30),

  L('shortcut', 'Are we allowed back here? We\'re not allowed back here.', 18),
  L('shortcut', 'This alley is not on the map. This alley is not on the MAP.', 18),
];

/* --- Doña Carmen — the abuela who hates your driving --------------------- */
const ABUELA: readonly DialogueLine[] = [
  L('hail', 'Nene, ven acá. Y no me toques bocina, que ya te oí.', 30),
  L('hail', 'Muchacho. Aquí. Sí, tú.', 30),
  L('hail', '¿Está libre? Bueno, pues bájese y ayúdeme con la bolsa.', 30),

  L('pickup', 'Vamos a la capilla. Y despacio, que yo tengo huesos, no repuestos.', 45),
  L('pickup', 'Ponte el cinturón tú también. Uno nunca sabe contigo.', 45),

  L('idle', 'Tu mamá sabe que tú manejas así, ¿verdad?', 45),
  L('idle', 'En mis tiempos el taxista te abría la puerta.', 50),
  L('idle', 'Yo crié cinco hijos. Ninguno maneja como tú, gracias a Dios.', 55),
  L('idle', 'Cuidado con el adoquín mojado, que ese no perdona.', 45),
  L('idle', 'Yo nací a dos cuadras de aquí. La casa todavía está de pie. Igual que yo.', 55),
  L('idle', '¿Tú comiste hoy? Estás flaco.', 50),

  L('drift', '¡Nene! ¡Las dos manos en el guía!', 8),
  L('drift', '¡Ave María purísima!', 8),
  L('drift', 'Yo me bajo. Yo me bajo aquí mismo.', 10, 'terrified'),

  L('jump', '¡Que yo tengo la cadera operada, muchacho!', 8),
  L('jump', '¡Se te olvidó que esto no vuela!', 8),

  L('nearMiss', 'Ese señor tenía luz verde y tú lo sabes.', 9),
  L('nearMiss', 'Un día de estos, nene. Un día de estos.', 9),

  L('crash', '¿Tú ves? ¿Tú ves lo que yo te digo?', 8),
  L('crash', 'Eso te pasa por ir corriendo. Siempre corriendo.', 8),

  L('boost', '¿Y esa prisa? ¿Se está quemando algo?', 14),
  L('boost', 'Más despacio se llega igual. Pregúntame a mí.', 14),

  L('wrongWay', 'Por ahí no, corazón. Yo nací en esta calle.', 15),
  L('wrongWay', 'Vira. Vira, te digo. No me hagas repetirlo.', 15),

  L('almostThere', 'Ya llegamos. Y llegamos vivos, milagro.', 20),
  L('almostThere', 'Ahí está. Párate donde yo te diga, no donde tú quieras.', 20),

  L('dropoff', 'Toma. No es propina, es pa\' que arregles esos frenos.', 30),
  L('dropoff', 'Que Dios te bendiga. Y que te enseñe a frenar.', 30),

  L('perfect', 'Bueno... manejaste bien. No te acostumbres.', 30),
  L('perfect', 'Mira eso. Cuando quieres, sabes. Que conste que lo dije.', 30),

  L('timeout', 'Me voy caminando. Camino más rápido que tú, de todos modos.', 30),

  L('shortcut', 'Por ahí se metía tu abuelo cuando llegaba tarde. Igualito.', 18),
  L('shortcut', 'Ese callejón huele a café desde que yo era nena.', 18),
];

/* --- Yaniel — muralist chasing the light --------------------------------- */
const MURALIST: readonly DialogueLine[] = [
  L('hail', '¡Ey! ¿Me llevas? Traigo latas, no me las agites mucho.', 30),
  L('hail', 'Pana, un viaje. La luz se me va.', 30),
  L('hail', '¿Libre? Voy corto pero voy tarde.', 30),

  L('pickup', 'Pa\' la pared grande del callejón. La luz buena se va a las seis.', 45),
  L('pickup', 'Dale. Y si ves una pared en blanco, avísame.', 45),

  L('idle', 'Mira ese balcón. Ese verde no lo inventa nadie.', 45),
  L('idle', 'Yo pinto lo que la gente ya sabe, pero en grande.', 50),
  L('idle', 'Esa pared lleva dos años pidiéndome algo.', 50),
  L('idle', 'El truco no es el color. Es dónde lo pones.', 50),
  L('idle', 'Ese portón lo pinté yo. Hace seis años. Todavía aguanta.', 55),

  L('drift', 'Eso dejó una línea bien limpia en el piso, ¿ah?', 12),
  L('drift', 'Ese trazo va de una. Sin levantar la mano.', 12),

  L('jump', '¡Diablo! Eso hay que pintarlo.', 12),
  L('jump', 'Ahí arriba se ve otro Viejo San Juan, ¿tú sabes?', 12),

  L('nearMiss', 'Tranquilo, tranquilo. Bien ahí.', 10),
  L('nearMiss', 'Ese pasó pegadito. Respeto.', 10),

  L('crash', 'Ey. Las latas, pana. Las latas.', 8),
  L('crash', 'Nah, mano. Eso no iba en el boceto.', 8),

  L('boost', 'Dale, que la luz no espera a nadie.', 14),
  L('boost', 'Métele. Yo llego con las manos temblando igual.', 14),

  L('wrongWay', 'Nah, la pared está pa\' allá.', 15),
  L('wrongWay', 'Estamos yendo en contra, pana.', 15),

  L('almostThere', 'Ya la veo. Todavía en blanco, qué rico.', 20),
  L('almostThere', 'Ahí mismo. Déjame en la esquina.', 20),

  L('dropoff', 'Gracias, pana. Cuando pases por aquí, búscate en la pared.', 30),
  L('dropoff', 'Toma. Y mira pa\' arriba de vez en cuando, que ahí está lo bueno.', 30),

  L('perfect', 'Eso fue arte. Y yo sé de eso.', 30),
  L('perfect', 'Limpio, rápido y con estilo. Los tres, mano. Difícil.', 30),

  L('timeout', 'Me voy a pie. La luz no me espera a mí tampoco.', 30),

  L('shortcut', 'Ese callejón tiene el mejor muro de la isla. Buen ojo.', 18),
  L('shortcut', 'Métete por ahí, que ahí nadie te ve pintar.', 18),
];

/* --- Tato — surfer chasing the swell ------------------------------------- */
const SURFER: readonly DialogueLine[] = [
  L('hail', '¡Ey, bro! ¿Me tiras pa\'l otro lado? El swell está entrando.', 30),
  L('hail', '¡Taxi! Con tabla y todo, ¿se puede?', 30),
  L('hail', 'Pana, un viaje rápido. Y cuando digo rápido, digo rápido.', 30),

  L('pickup', 'La tabla va atrás, tú métele. Es la mejor hora del día.', 45),
  L('pickup', 'Dale sin miedo, bro. Yo me caigo de olas de cuatro pies.', 45),

  L('idle', 'Bro, el agua hoy está de otro planeta.', 45),
  L('idle', 'Yo trabajo pa\' surfear, no surfeo pa\' trabajar.', 50),
  L('idle', 'Si vamos rápido llego pa\' la marea alta. Just saying.', 50),
  L('idle', 'Mi jefe cree que estoy en el dentista. Segunda vez esta semana.', 55),
  L('idle', 'La primera ola siempre es la mejor y siempre se me va.', 50),

  L('drift', '¡Wepaaa! ¡Eso fue un bottom turn!', 10),
  L('drift', '¡Aguanta la línea, bro! ¡Ahí, ahí!', 10),
  L('drift', '¡Esto es mejor que la ola, mano!', 10, 'thrilled'),

  L('jump', '¡AIR! ¡Eso fue un air, bro!', 9),
  L('jump', '¡Se fue en aéreo! ¡Se fue!', 9),

  L('nearMiss', '¡Ese fue apretao! ¡Brutal!', 9),
  L('nearMiss', 'Bro, le pasaste por dentro. Como en el tubo.', 9),

  L('crash', 'Ay. Okay. Eso me dolió a mí y yo no manejo.', 8),
  L('crash', 'La tabla, bro. La tabla es lo único que me importa.', 8),

  L('boost', '¡Dale, dale, dale! ¡Esto es una ola!', 12),
  L('boost', '¡Suéltalo todo! ¡No frenes!', 12),

  L('wrongWay', 'Bro. El mar. Está. Pa\' allá.', 15),
  L('wrongWay', 'Vamos en contra de la corriente, literal.', 15),

  L('almostThere', '¡Ya huelo la sal! Métele, métele.', 18),
  L('almostThere', 'Se ve el line-up desde aquí. ¡Está limpio!', 18),

  L('dropoff', '¡Brutal, pana! Toma, y si me ves por allá te enseño a coger una.', 30),
  L('dropoff', 'Eso fue un viaje. Nos vemos en el agua, bro.', 30),

  L('perfect', 'Eso estuvo mejor que la sesión. Y la sesión va a estar buena.', 30),
  L('perfect', 'Bro, tú surfeas la calle. Respeto total.', 30),

  L('timeout', 'Nah, me voy en la guagua. Pero pierdes tú, bro.', 30),

  L('shortcut', '¡Ese atajo es un secreto! Ahora somos socios.', 18),
  L('shortcut', 'Por ahí bajaba yo en patineta. Mala idea, buena historia.', 18),
];

/* --- Profesora Iris — historian and tour guide --------------------------- */
const TOUR_GUIDE: readonly DialogueLine[] = [
  L('hail', 'Disculpe, ¿está libre? Tengo un grupo esperándome y voy tarde.', 30),
  L('hail', 'Aquí, por favor. Y le advierto: hablo mucho.', 30),
  L('hail', '¿Me lleva? Prometo pagarle en efectivo y en datos.', 30),

  L('pickup', 'Al mirador, por favor. Y si puede, por la calle de los adoquines azules.', 45),
  L('pickup', 'Gracias. Aproveche, que hoy le toca el recorrido gratis.', 45),

  L('idle', 'Esos adoquines llegaron como lastre en los barcos. Fíjese en el azul.', 50),
  L('idle', 'La garita no es decoración: era un puesto de guardia. Ahí dormía gente.', 55),
  L('idle', 'Cuatrocientos años de ciudad y usted la cruza en cuatro minutos. Impresionante y preocupante.', 55),
  L('idle', 'Ese balcón es de hierro colado del siglo diecinueve. Cuidado con él, se lo pido.', 50),
  L('idle', 'Las casas se pintan de colores por ordenanza, no por capricho. Y menos mal.', 55),
  L('idle', 'Aquí las distancias van en kilómetros y la velocidad en millas. No pregunte.', 55),

  L('drift', '¡Esto es patrimonio de la humanidad, no una pista!', 10),
  L('drift', 'Señor. Señor. Ese muro tiene cuatro siglos.', 10),

  L('jump', 'Eso no aparece en ninguno de mis recorridos.', 10),
  L('jump', 'Voy a tener que replantearme el itinerario.', 10),

  L('nearMiss', 'Ese peatón tenía derecho de paso. Legal e históricamente.', 10),
  L('nearMiss', 'Le faltó así. Así, mire mis dedos.', 10),

  L('crash', 'Bueno. Eso también es parte de la experiencia, supongo.', 8),
  L('crash', 'Espero que eso no fuera una fachada protegida.', 8),

  L('boost', 'Más despacio se ve más ciudad, se lo aseguro.', 14),
  L('boost', 'Rápido no es lo mismo que eficiente, joven.', 14),

  L('wrongWay', 'Va en dirección contraria. Lo sé porque llevo veinte años caminando esto.', 15),
  L('wrongWay', 'Esa calle es de una sola vía desde 1968. Lo he verificado.', 15),

  L('almostThere', 'Ya se ve la muralla. Excelente.', 20),
  L('almostThere', 'Mi grupo está ahí. Los veo. Están mirando el reloj.', 20),

  L('dropoff', 'Llegué a tiempo. Tenga, y venga al recorrido de las seis. Invita la casa.', 30),
  L('dropoff', 'Gracias. Usted acaba de participar en un dato histórico menor.', 30),

  L('perfect', 'Rápido y sin un rasguño en la ciudad. Eso sí lo voy a contar.', 30),
  L('perfect', 'Impecable. Y créame, yo califico gente para vivir.', 30),

  L('timeout', 'Me voy caminando. Es lo que hago, después de todo.', 30),

  L('shortcut', 'Esa callejuela sale en un plano de 1782. Buen ojo.', 18),
  L('shortcut', 'Por ahí subían el agua a la cisterna. Fascinante, y conveniente.', 18),
];

/* --- Bryan — nervous first-timer ----------------------------------------- */
const FIRST_TIMER: readonly DialogueLine[] = [
  L('hail', 'Um — ¿taxi? Perdón, mi español está... trabajando en eso.', 30),
  L('hail', '¿Hola? ¿Es este el sitio donde uno espera? Nadie me dijo.', 30),
  L('hail', '¡Ey! ¿Libre? Por favor di que sí.', 30),

  L('pickup', 'Es mi primera semana aquí. ¿Esto es normal? El carro, digo.', 45),
  L('pickup', 'Okay. Okay. Me monté. Ya está. Ya me monté.', 45),

  L('idle', '¿Los carros aquí siempre van así de rápido?', 45),
  L('idle', 'Mi mamá me dijo que no montara en carros sin puertas. Este no tiene puertas.', 55),
  L('idle', 'Aprendí "chévere" ayer. Lo he usado once veces.', 50),
  L('idle', '¿Eso de allá es un fuerte? ¿De verdad? ¿Un fuerte de verdad?', 50),
  L('idle', 'Me mudé por trabajo. El trabajo empieza el lunes. Hoy es martes.', 55),
  L('idle', 'Todo el mundo aquí me dice "papi". Yo tengo veintitrés años.', 55),

  L('drift', '¡NO NO NO — okay. Okay. Estamos bien. Estamos bien.', 8),
  L('drift', '¿Eso lo hiciste a propósito? Por favor di que sí.', 8),
  L('drift', 'Me quiero bajar. Digo, no. Sí. No sé.', 10, 'terrified'),

  L('jump', '¿ESO FUE UNA RAMPA? ¡ESO FUE UNA RAMPA!', 8),
  L('jump', 'Vi el cielo. Vi el cielo desde abajo del carro.', 8),

  L('nearMiss', 'Cerré los ojos. Perdón. Cerré los ojos.', 9),
  L('nearMiss', 'Ese señor me miró. Me miró a los ojos.', 9),

  L('crash', '¿Le pagamos a alguien por eso, o...?', 8),
  L('crash', 'En mi pueblo eso sale en las noticias.', 8),

  L('boost', '¿Todo este tiempo había más velocidad?', 14),
  L('boost', 'No hacía falta. De verdad que no hacía falta.', 14),

  L('wrongWay', 'Creo... creo que era por el otro lado. Pero yo qué sé.', 15),
  L('wrongWay', 'El mapa del teléfono está gritando. Literalmente gritando.', 15),

  L('almostThere', '¡Es esa! ¡Esa de ahí! ¡Esa me la sé!', 18),
  L('almostThere', 'Reconozco esa esquina. Me perdí ahí el domingo.', 18),

  L('dropoff', 'Llegué vivo. Gracias. De verdad, gracias.', 30),
  L('dropoff', 'Tenga. ¿Se dice "quédese con el cambio"? Eso. Eso mismo.', 30),

  L('perfect', 'Okay, eso estuvo... eso estuvo chévere. ¿Lo usé bien?', 30),
  L('perfect', 'Le voy a mandar un mensaje a mi mamá. Editado.', 30),

  L('timeout', 'Voy a caminar. Necesito caminar un rato. Solo.', 30),

  L('shortcut', '¿Se puede pasar por ahí? ¿Se puede? Okay. Okay.', 18),
  L('shortcut', 'Esto no sale en ninguna aplicación. Eso me preocupa un poco.', 18),
];

/* --- Millie — salsa dancer, late to rehearsal ---------------------------- */
const SALSA_DANCER: readonly DialogueLine[] = [
  L('hail', '¡Taxi! Ensayo en veinte y todavía no he calentado.', 30),
  L('hail', '¡Aquí, aquí! Con tacones no se corre, corazón.', 30),
  L('hail', '¿Libre? Perfecto. Vamos en el uno.', 30),

  L('pickup', 'Al salón, y mantén el tiempo. Uno, dos, tres... cinco, seis, siete.', 45),
  L('pickup', 'Dale. Y si te sabes la clave, mejor.', 45),

  L('idle', 'Si llego fría, la maestra me mata.', 45),
  L('idle', 'Tú tienes ritmo pa\' manejar, pero el freno lo llevas en contratiempo.', 55),
  L('idle', 'Ponme algo con clave y te perdono el susto.', 50),
  L('idle', 'Llevo bailando desde los seis. Caminar me aburre.', 50),
  L('idle', 'El compañero nuevo me pisa. Todos los martes. Sin fallar.', 55),

  L('drift', '¡Eso fue una vuelta doble! ¡Eso cuenta!', 10),
  L('drift', '¡Ay! ¡Con estilo y todo!', 10),

  L('jump', '¡Eso fue un levantamiento! ¡Y sin manos!', 10),
  L('jump', '¡Ese es el paso que no me sale a mí!', 10),

  L('nearMiss', '¡Uy! Ese cruce estuvo en el uno.', 9),
  L('nearMiss', 'Le pasaste rozando. Eso en pista se llama confianza.', 9),

  L('crash', '¡Fuera de tiempo, mi amor! ¡Fuera de tiempo!', 8),
  L('crash', 'Ay, el tobillo. El tobillo no, por favor.', 8),

  L('boost', '¡Ahora sí, eso es tempo!', 12),
  L('boost', '¡Métele, que esto se puso en descarga!', 12),

  L('wrongWay', 'Vas en contra del paso. Vira, vira.', 15),
  L('wrongWay', 'Corazón, eso es para el otro lado y tú lo sabes.', 15),

  L('almostThere', 'Ya oigo los cueros. ¡Métele!', 18),
  L('almostThere', 'Están calentando sin mí. Los oigo.', 18),

  L('dropoff', 'Llegué caliente y a tiempo. Toma, y vente a bailar un día.', 30),
  L('dropoff', 'Gracias, mi amor. Los martes a las siete, por si acaso.', 30),

  L('perfect', 'Perfecto. Del uno al ocho, en clave. Brutal.', 30),
  L('perfect', 'Tú no manejas, tú bailas. Que alguien te lo diga más seguido.', 30),

  L('timeout', 'Me voy corriendo. Igual es calentamiento.', 30),

  L('shortcut', 'Ese atajo tiene swing.', 18),
  L('shortcut', 'Por ahí salí una noche de San Sebastián. No preguntes.', 18),
];

/* --- K-Bo — trap artist with studio time booked -------------------------- */
const TRAP_ARTIST: readonly DialogueLine[] = [
  L('hail', 'Ey, taxi. Tengo estudio reservado y el beat no espera.', 30),
  L('hail', 'Pana, aquí. Voy pa\' la sesión.', 30),
  L('hail', '¿Libre? Dale, que estoy pagando por hora.', 30),

  L('pickup', 'Dale, arranca. Voy grabando notas de voz, no te asustes si hablo solo.', 45),
  L('pickup', 'Métele. Yo te bajo la ventana... ah, verdad que no hay ventana.', 45),

  L('idle', 'Nota de voz: "la ciudad suena a hi-hats mojados". Bien ahí.', 50),
  L('idle', 'Todo el mundo cree que esto salió de Miami. Salió de aquí, de este bloque.', 55),
  L('idle', 'Si me traes rápido te menciono en los créditos. Palabra.', 50),
  L('idle', 'Grabé mi primer tema en el cuarto de mi abuela. Con un micrófono prestado.', 55),
  L('idle', 'El productor me cobra igual si llego tarde. Por eso te escogí a ti.', 55),

  L('drift', '¡Ese sonido! Guárdalo, eso va en el intro.', 10),
  L('drift', '¡Se formó! ¡Se formó, mano!', 10),

  L('jump', '¡Eso sonó a un 808! ¡Brutal!', 10),
  L('jump', '¡Nos fuimos! ¡Eso va en el video!', 10),

  L('nearMiss', 'Uff, ese pasó pegadito. Eso es una barra completa.', 9),
  L('nearMiss', 'Frío. Bien frío, pana.', 9),

  L('crash', 'Ey, ey. El equipo, mano. El equipo.', 8),
  L('crash', 'Nah. Esa no la grabé. Esa no pasó.', 8),

  L('boost', '¡Métele! ¡Esto va a doble tiempo!', 12),
  L('boost', '¡Ahí, ahí! Eso es el drop.', 12),

  L('wrongWay', 'Nah, nah, el estudio está pa\'l otro lado. Confía.', 15),
  L('wrongWay', 'Mano, estamos yendo al revés. Literal al revés.', 15),

  L('almostThere', 'Ya casi. Déjame calentar la voz.', 18),
  L('almostThere', 'Veo la puerta. El productor está afuera fumando, seguro.', 18),

  L('dropoff', 'Brutal. Toma, y busca el tema el viernes. Sales tú ahí adentro.', 30),
  L('dropoff', 'Eso fue una sesión antes de la sesión. Gracias, mano.', 30),

  L('perfect', 'Eso fue una obra maestra. Y yo sé de obras maestras.', 30),
  L('perfect', 'Tú tienes flow manejando. Eso no se enseña.', 30),

  L('timeout', 'Nada, me busco otra cosa. Sin ofender, pana.', 30),

  L('shortcut', '¿Tú conocías ese atajo? Respeto, mano.', 18),
  L('shortcut', 'Por ese callejón grabamos el video. Se ve brutal de noche.', 18),
];

/** Used for any archetype without its own bank — should never be needed. */
export const GENERIC_DIALOGUE: readonly DialogueLine[] = [
  L('hail', '¡Taxi! ¡Aquí!', 25),
  L('pickup', 'Dale, que se me hace tarde.', 30),
  L('idle', 'Bonita tarde, ¿verdad?', 40),
  L('idle', 'Yo cojo este carro todos los días. Bueno, no este.', 45),
  L('drift', '¡Wepa!', 10),
  L('jump', '¡Volamos!', 10),
  L('nearMiss', '¡Ese estuvo cerca!', 9),
  L('crash', '¡Ay!', 8),
  L('boost', '¡Métele!', 12),
  L('wrongWay', 'Es para el otro lado.', 15),
  L('almostThere', 'Ya casi llegamos.', 18),
  L('dropoff', 'Gracias, quédate con el cambio.', 25),
  L('perfect', '¡Brutal! Nada que decir.', 25),
  L('timeout', 'Me voy caminando.', 25),
  L('shortcut', 'Buen atajo.', 18),
];

export const DIALOGUE: Readonly<Record<string, readonly DialogueLine[]>> = {
  'bomba-drummer': BOMBA_DRUMMER,
  'bakery-owner': BAKERY_OWNER,
  'cruise-guest': CRUISE_GUEST,
  abuela: ABUELA,
  muralist: MURALIST,
  surfer: SURFER,
  'tour-guide': TOUR_GUIDE,
  'first-timer': FIRST_TIMER,
  'salsa-dancer': SALSA_DANCER,
  'trap-artist': TRAP_ARTIST,
};

/** Total authored lines — used by the harness to assert the bank stayed big. */
export function dialogueLineCount(): number {
  let n = GENERIC_DIALOGUE.length;
  for (const id of Object.keys(DIALOGUE)) n += DIALOGUE[id].length;
  return n;
}

/* --------------------------------------------------------------- director */

const TRIGGERS: readonly DialogueTrigger[] = [
  'hail',
  'pickup',
  'idle',
  'drift',
  'jump',
  'nearMiss',
  'crash',
  'boost',
  'wrongWay',
  'almostThere',
  'dropoff',
  'perfect',
  'timeout',
  'shortcut',
];

/** Higher wins when two triggers land close together. */
const PRIORITY: Readonly<Record<DialogueTrigger, number>> = {
  idle: 0,
  boost: 1,
  shortcut: 2,
  drift: 2,
  nearMiss: 2,
  wrongWay: 3,
  jump: 3,
  almostThere: 4,
  crash: 5,
  hail: 6,
  pickup: 7,
  timeout: 7,
  dropoff: 8,
  perfect: 8,
};

interface CompiledLine {
  text: string;
  mood: PassengerMood | undefined;
  cooldown: number;
  lastSaid: number;
}

type CompiledBank = Map<DialogueTrigger, CompiledLine[]>;

function compile(lines: readonly DialogueLine[]): CompiledBank {
  const bank: CompiledBank = new Map();
  for (const t of TRIGGERS) bank.set(t, []);
  for (const line of lines) {
    const list = bank.get(line.trigger);
    if (!list) continue;
    list.push({
      text: line.text,
      mood: line.mood,
      cooldown: line.cooldown ?? 20,
      lastSaid: Number.NEGATIVE_INFINITY,
    });
  }
  return bank;
}

export interface DialogueDirectorOptions {
  bus: EventBus;
  rng: RNG;
  /** minimum seconds between any two lines from the same passenger */
  minGap?: number;
  /** a higher-priority trigger may interrupt after this many seconds */
  interruptGap?: number;
  /** idle chatter spacing, seconds */
  idleMin?: number;
  idleMax?: number;
}

/**
 * Decides who talks and when, then emits `passenger:say`. One instance is
 * shared by the whole mission system; per-archetype cooldowns persist across a
 * shift so the player does not hear the same joke twice in five minutes.
 */
export class DialogueDirector {
  private readonly bus: EventBus;
  private readonly rng: RNG;
  private readonly minGap: number;
  private readonly interruptGap: number;
  private readonly idleMin: number;
  private readonly idleMax: number;

  private readonly banks = new Map<string, CompiledBank>();
  private readonly generic = compile(GENERIC_DIALOGUE);

  /** scratch candidate buffer — reused, never reallocated */
  private readonly candidates: CompiledLine[] = [];

  private lastSpokeAt = Number.NEGATIVE_INFINITY;
  private lastPriority = -1;
  private nextIdleAt = 0;

  /** the payload object is reused; the bus copies nothing, so refill it each time */
  private readonly payload = { archetypeId: '', text: '', trigger: 'idle' as DialogueTrigger };

  constructor(opts: DialogueDirectorOptions) {
    this.bus = opts.bus;
    this.rng = opts.rng;
    this.minGap = opts.minGap ?? 1.6;
    this.interruptGap = opts.interruptGap ?? 0.45;
    this.idleMin = opts.idleMin ?? 7;
    this.idleMax = opts.idleMax ?? 14;
    for (const id of Object.keys(DIALOGUE)) this.banks.set(id, compile(DIALOGUE[id]));
  }

  /** Clear every cooldown — call at the start of a shift. */
  reset(now = 0): void {
    for (const bank of this.banks.values()) {
      for (const list of bank.values()) {
        for (const line of list) line.lastSaid = Number.NEGATIVE_INFINITY;
      }
    }
    for (const list of this.generic.values()) {
      for (const line of list) line.lastSaid = Number.NEGATIVE_INFINITY;
    }
    this.lastSpokeAt = Number.NEGATIVE_INFINITY;
    this.lastPriority = -1;
    this.nextIdleAt = now + this.idleMin;
  }

  /** A new passenger boarded — re-arm the idle timer. */
  onBoard(now: number): void {
    this.nextIdleAt = now + this.rng.range(this.idleMin * 0.6, this.idleMax * 0.7);
  }

  /**
   * Try to speak. Returns true when a line actually went out.
   * `force` bypasses the global gap (used for pickup/dropoff beats).
   */
  say(
    archetypeId: string,
    trigger: DialogueTrigger,
    mood: PassengerMood,
    now: number,
    force = false,
  ): boolean {
    const prio = PRIORITY[trigger];
    if (!force) {
      const since = now - this.lastSpokeAt;
      if (since < this.interruptGap) return false;
      if (since < this.minGap && prio <= this.lastPriority) return false;
    }

    const bank = this.banks.get(archetypeId) ?? this.generic;
    let list = bank.get(trigger);
    if (!list || list.length === 0) list = this.generic.get(trigger);
    if (!list || list.length === 0) return false;

    const cand = this.candidates;
    cand.length = 0;

    // pass 1: mood-specific lines that are off cooldown
    for (let i = 0; i < list.length; i++) {
      const line = list[i];
      if (line.mood !== mood) continue;
      if (now - line.lastSaid < line.cooldown) continue;
      cand.push(line);
    }
    // pass 2: mood-agnostic lines that are off cooldown
    if (cand.length === 0) {
      for (let i = 0; i < list.length; i++) {
        const line = list[i];
        if (line.mood !== undefined) continue;
        if (now - line.lastSaid < line.cooldown) continue;
        cand.push(line);
      }
    }
    // pass 3: everything is on cooldown — take the stalest mood-agnostic line,
    // but only for beats the player must hear.
    if (cand.length === 0) {
      if (prio < PRIORITY.almostThere) return false;
      let stalest: CompiledLine | null = null;
      for (let i = 0; i < list.length; i++) {
        const line = list[i];
        if (line.mood !== undefined) continue;
        if (!stalest || line.lastSaid < stalest.lastSaid) stalest = line;
      }
      if (!stalest) return false;
      cand.push(stalest);
    }

    const chosen = cand.length === 1 ? cand[0] : cand[Math.floor(this.rng.next() * cand.length) % cand.length];
    chosen.lastSaid = now;
    this.lastSpokeAt = now;
    this.lastPriority = prio;
    if (trigger !== 'idle') this.nextIdleAt = now + this.rng.range(this.idleMin, this.idleMax);

    this.payload.archetypeId = archetypeId;
    this.payload.text = chosen.text;
    this.payload.trigger = trigger;
    this.bus.emit('passenger:say', this.payload);
    return true;
  }

  /** Call every frame while someone is aboard; paces ambient chatter. */
  tickIdle(archetypeId: string, mood: PassengerMood, now: number): void {
    if (now < this.nextIdleAt) return;
    this.nextIdleAt = now + this.rng.range(this.idleMin, this.idleMax);
    this.say(archetypeId, 'idle', mood, now);
  }

  /** Push the idle clock out — used while the passenger is mid-reaction. */
  suppressIdle(now: number, seconds: number): void {
    const target = now + seconds;
    if (target > this.nextIdleAt) this.nextIdleAt = target;
  }
}
